//! Session state and PTY spawning. Each session has many subscribers (clients
//! receiving its output) and one PTY reader thread that fans out events.

use std::io::{Read, Write};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};

use napkin_proto::{ServerMsg, ServerOp};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};

use crate::osc::{OscEvent, OscScanner};
use crate::shim::ensure_zsh_shim;

/// Maximum PTY bytes retained per session for replay on reattach.
/// Roughly 2 MB — enough to cover ~10k lines of typical agent output while
/// keeping the one-shot replay payload under ~10 MB of JSON-encoded bytes.
pub(crate) const SCROLLBACK_LIMIT: usize = 2 * 1024 * 1024;

pub(crate) struct Session {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub cwd: String,
    pub subscribers: Vec<Sender<ServerMsg>>,
    /// Agent classification for the currently-executing foreground command,
    /// or None when idle or running a non-agent command.
    pub current_agent: Option<&'static str>,
    /// Ring buffer of raw PTY bytes kept for replay when a client reattaches.
    pub scrollback: Vec<u8>,
}

impl Session {
    pub fn append_scrollback(&mut self, data: &[u8]) {
        self.scrollback.extend_from_slice(data);
        if self.scrollback.len() > SCROLLBACK_LIMIT {
            let drop = self.scrollback.len() - SCROLLBACK_LIMIT;
            self.scrollback.drain(0..drop);
        }
    }
}

pub(crate) fn spawn_session(
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    shell: Option<String>,
    initial_subscriber: Sender<ServerMsg>,
) -> Result<(String, Arc<Mutex<Session>>), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    // Session id is generated up front so processes inside the PTY can
    // phone home via `napkin hook ...`.
    let session_id = uuid::Uuid::new_v4().to_string();
    let socket = napkin_proto::socket_path();

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("NAPKIN", "1");
    cmd.env("NAPKIN_SESSION_ID", &session_id);
    cmd.env("NAPKIN_SOCKET", socket.to_string_lossy().to_string());
    // Put the napkin CLI on PATH so `napkin hook …` works from within the
    // spawned shell. The CLI binary lives next to napkind in every build.
    if let Some(dir) = current_exe_dir() {
        let existing = std::env::var("PATH").unwrap_or_default();
        let new_path = if existing.is_empty() {
            dir.to_string_lossy().to_string()
        } else {
            format!("{}:{existing}", dir.to_string_lossy())
        };
        cmd.env("PATH", new_path);
    }

    let is_zsh = shell.ends_with("/zsh") || shell == "zsh";
    if is_zsh {
        if let Ok(dir) = ensure_zsh_shim() {
            cmd.env("ZDOTDIR", dir);
        }
    }

    let start_cwd = cwd
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| "/".into());
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

    let session = Arc::new(Mutex::new(Session {
        master: pair.master,
        writer,
        cwd: start_cwd.clone(),
        subscribers: vec![initial_subscriber],
        current_agent: None,
        scrollback: Vec::new(),
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
                    {
                        let mut s = lock_or_recover(&session_for_reader);
                        s.append_scrollback(&data);
                    }
                    broadcast(
                        &session_for_reader,
                        ServerMsg {
                            id: None,
                            op: ServerOp::Output {
                                session_id: emit_id.clone(),
                                data,
                            },
                        },
                    );
                    for ev in events {
                        handle_osc(&session_for_reader, &emit_id, ev);
                    }
                }
                Err(_) => break,
            }
        }
        broadcast(
            &session_for_reader,
            ServerMsg {
                id: None,
                op: ServerOp::Exit {
                    session_id: emit_id.clone(),
                },
            },
        );
    });

    // Reaper
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok((session_id, session))
}

fn handle_osc(session: &Arc<Mutex<Session>>, session_id: &str, ev: OscEvent) {
    match ev {
        OscEvent::Cwd(cwd) => {
            {
                let mut s = lock_or_recover(session);
                s.cwd = cwd.clone();
            }
            broadcast(
                session,
                ServerMsg {
                    id: None,
                    op: ServerOp::Cwd {
                        session_id: session_id.to_string(),
                        cwd,
                    },
                },
            );
        }
        OscEvent::PromptStart => {
            broadcast(
                session,
                ServerMsg {
                    id: None,
                    op: ServerOp::Mark {
                        session_id: session_id.to_string(),
                        mark: "A".into(),
                        exit: None,
                    },
                },
            );
        }
        OscEvent::CommandStart => {
            broadcast(
                session,
                ServerMsg {
                    id: None,
                    op: ServerOp::Mark {
                        session_id: session_id.to_string(),
                        mark: "C".into(),
                        exit: None,
                    },
                },
            );
        }
        OscEvent::CommandEnd(exit_code) => {
            broadcast(
                session,
                ServerMsg {
                    id: None,
                    op: ServerOp::Mark {
                        session_id: session_id.to_string(),
                        mark: "D".into(),
                        exit: exit_code,
                    },
                },
            );
            let had_agent = {
                let mut s = lock_or_recover(session);
                s.current_agent.take().is_some()
            };
            if had_agent {
                broadcast(
                    session,
                    ServerMsg {
                        id: None,
                        op: ServerOp::Agent {
                            session_id: session_id.to_string(),
                            agent: None,
                        },
                    },
                );
            }
        }
        OscEvent::CommandLine(cmd) => {
            let classified = classify_agent(&cmd);
            let changed = {
                let mut s = lock_or_recover(session);
                if s.current_agent == classified {
                    false
                } else {
                    s.current_agent = classified;
                    true
                }
            };
            if changed {
                broadcast(
                    session,
                    ServerMsg {
                        id: None,
                        op: ServerOp::Agent {
                            session_id: session_id.to_string(),
                            agent: classified.map(|name| name.to_string()),
                        },
                    },
                );
            }
        }
    }
}

/// Map a shell command to a known AI-agent name, or None.
/// Only matches on the first whitespace-separated token's basename, so it
/// ignores args and absolute paths.
fn classify_agent(command_line: &str) -> Option<&'static str> {
    let first = command_line.split_whitespace().next()?;
    let binary = first.rsplit('/').next()?;
    match binary {
        "claude" | "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor-agent" => Some("cursor"),
        "aider" => Some("aider"),
        "opencode" => Some("opencode"),
        "gemini" => Some("gemini"),
        _ => None,
    }
}

fn current_exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::PathBuf::from))
}

/// Send a message to every live subscriber; drop any whose channel has closed.
fn broadcast(session: &Arc<Mutex<Session>>, msg: ServerMsg) {
    let mut s = lock_or_recover(session);
    s.subscribers.retain(|tx| tx.send(msg.clone()).is_ok());
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Session state is cheap to recover and should survive unrelated panics.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
