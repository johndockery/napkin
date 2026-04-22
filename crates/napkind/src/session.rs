//! Session state and PTY spawning. Each session has many subscribers (clients
//! receiving its output) and one PTY reader thread that fans out events.

use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use napkin_proto::{ServerMsg, ServerOp};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::osc::{OscEvent, OscScanner};
use crate::shim::ensure_zsh_shim;

#[derive(Clone, Debug)]
pub struct CommandRecord {
    pub started_at_ms: u128,
    pub ended_at_ms: Option<u128>,
    pub exit_code: Option<i32>,
    pub cwd: String,
}

pub struct Session {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub cwd: String,
    pub subscribers: Vec<Sender<ServerMsg>>,
    pub command_log: Vec<CommandRecord>,
    pub current: Option<CommandRecord>,
}

pub fn spawn_session(
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell: Option<String>,
    initial_subscriber: Sender<ServerMsg>,
) -> Result<(String, Arc<Mutex<Session>>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("NAPKIN", "1");

    let is_zsh = shell.ends_with("/zsh") || shell == "zsh";
    if is_zsh {
        if let Ok(dir) = ensure_zsh_shim() {
            cmd.env("ZDOTDIR", dir);
        }
    }

    let start_cwd = cwd.or_else(|| std::env::var("HOME").ok()).unwrap_or_else(|| "/".into());
    cmd.cwd(&start_cwd);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(Mutex::new(Session {
        master: pair.master,
        writer,
        cwd: start_cwd.clone(),
        subscribers: vec![initial_subscriber],
        command_log: Vec::new(),
        current: None,
    }));

    // Reader thread
    let session_for_reader = session.clone();
    let emit_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut scanner = OscScanner::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let events = scanner.feed(&data);
                    broadcast(&session_for_reader, ServerMsg {
                        id: None,
                        op: ServerOp::Output { session_id: emit_id.clone(), data },
                    });
                    for ev in events {
                        handle_osc(&session_for_reader, &emit_id, ev);
                    }
                }
                Err(_) => break,
            }
        }
        broadcast(&session_for_reader, ServerMsg {
            id: None,
            op: ServerOp::Exit { session_id: emit_id.clone() },
        });
    });

    // Reaper
    std::thread::spawn(move || { let _ = child.wait(); });

    Ok((session_id, session))
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn handle_osc(session: &Arc<Mutex<Session>>, session_id: &str, ev: OscEvent) {
    match ev {
        OscEvent::Cwd(cwd) => {
            {
                let mut s = session.lock().unwrap();
                s.cwd = cwd.clone();
            }
            broadcast(session, ServerMsg {
                id: None,
                op: ServerOp::Cwd { session_id: session_id.to_string(), cwd },
            });
        }
        OscEvent::PromptStart => {
            broadcast(session, ServerMsg {
                id: None,
                op: ServerOp::Mark {
                    session_id: session_id.to_string(),
                    mark: "A".into(),
                    exit: None,
                },
            });
        }
        OscEvent::CommandStart => {
            {
                let mut s = session.lock().unwrap();
                let cwd = s.cwd.clone();
                s.current = Some(CommandRecord {
                    started_at_ms: now_ms(),
                    ended_at_ms: None,
                    exit_code: None,
                    cwd,
                });
            }
            broadcast(session, ServerMsg {
                id: None,
                op: ServerOp::Mark {
                    session_id: session_id.to_string(),
                    mark: "C".into(),
                    exit: None,
                },
            });
        }
        OscEvent::CommandEnd(exit_code) => {
            {
                let mut s = session.lock().unwrap();
                if let Some(mut rec) = s.current.take() {
                    rec.ended_at_ms = Some(now_ms());
                    rec.exit_code = exit_code;
                    s.command_log.push(rec);
                    if s.command_log.len() > 2000 {
                        let drop = s.command_log.len() - 2000;
                        s.command_log.drain(0..drop);
                    }
                }
            }
            broadcast(session, ServerMsg {
                id: None,
                op: ServerOp::Mark {
                    session_id: session_id.to_string(),
                    mark: "D".into(),
                    exit: exit_code,
                },
            });
        }
    }
}

/// Send a message to every live subscriber; drop any whose channel has closed.
fn broadcast(session: &Arc<Mutex<Session>>, msg: ServerMsg) {
    let mut s = session.lock().unwrap();
    s.subscribers.retain(|tx| tx.send(msg.clone()).is_ok());
}
