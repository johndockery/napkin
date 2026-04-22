//! napkind — the napkin workspace daemon.
//!
//! Listens on a unix socket. One PTY multiplexer, many clients.

mod osc;
mod session;
mod shim;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use napkin_proto::{socket_path, ClientMsg, ClientOp, ServerMsg, ServerOp, SessionInfo};
use portable_pty::PtySize;

use session::{spawn_session, Session};

type SessionMap = Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>;

fn main() {
    let path = socket_path();
    // Clean any stale socket file. If another napkind is running we'll bind
    // errors below and exit.
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("napkind: bind {} failed: {e}", path.display());
            std::process::exit(1);
        }
    };
    eprintln!("napkind: listening on {}", path.display());

    let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let sessions = sessions.clone();
                thread::spawn(move || handle_client(stream, sessions));
            }
            Err(e) => {
                eprintln!("napkind: accept error: {e}");
            }
        }
    }
}

fn handle_client(stream: UnixStream, sessions: SessionMap) {
    let (tx, rx) = std::sync::mpsc::channel::<ServerMsg>();
    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkind: clone stream failed: {e}");
            return;
        }
    };

    // Writer thread: drains rx and writes to socket
    let mut write_stream = stream;
    let writer_thread = thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            let Ok(line) = serde_json::to_string(&msg) else {
                continue;
            };
            if writeln!(write_stream, "{}", line).is_err() {
                break;
            }
        }
    });

    // Reader loop: read newline-delimited ClientMsg
    let reader = BufReader::new(read_stream);
    for line in reader.lines() {
        match line {
            Ok(line) if line.is_empty() => continue,
            Ok(line) => match serde_json::from_str::<ClientMsg>(&line) {
                Ok(msg) => dispatch(msg, &sessions, &tx),
                Err(e) => {
                    let _ = tx.send(ServerMsg {
                        id: None,
                        op: ServerOp::Err {
                            error: format!("parse: {e}"),
                        },
                    });
                }
            },
            Err(_) => break,
        }
    }

    drop(tx);
    let _ = writer_thread.join();
}

fn dispatch(msg: ClientMsg, sessions: &SessionMap, tx: &std::sync::mpsc::Sender<ServerMsg>) {
    let id = msg.id;
    let reply = |op: ServerOp| {
        let _ = tx.send(ServerMsg { id, op });
    };

    match msg.op {
        ClientOp::Ping => reply(ServerOp::Pong),

        ClientOp::Spawn {
            rows,
            cols,
            cwd,
            shell,
        } => match spawn_session(rows, cols, cwd, shell, tx.clone()) {
            Ok((sid, session)) => {
                lock_or_recover(sessions).insert(sid.clone(), session);
                reply(ServerOp::SpawnOk { session_id: sid });
            }
            Err(e) => reply(ServerOp::Err { error: e }),
        },

        ClientOp::Write { session_id, data } => {
            let Some(session) = lock_or_recover(sessions).get(&session_id).cloned() else {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            };
            let mut s = lock_or_recover(&session);
            match s.writer.write_all(&data) {
                Ok(()) => {
                    s.writer.flush().ok();
                    reply(ServerOp::Ok);
                }
                Err(e) => reply(ServerOp::Err {
                    error: e.to_string(),
                }),
            }
        }

        ClientOp::Resize {
            session_id,
            rows,
            cols,
        } => {
            let Some(session) = lock_or_recover(sessions).get(&session_id).cloned() else {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            };
            let s = lock_or_recover(&session);
            match s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                Ok(()) => reply(ServerOp::Ok),
                Err(e) => reply(ServerOp::Err {
                    error: e.to_string(),
                }),
            }
        }

        ClientOp::Kill { session_id } => {
            lock_or_recover(sessions).remove(&session_id);
            reply(ServerOp::Ok);
        }

        ClientOp::List => {
            let infos: Vec<SessionInfo> = lock_or_recover(sessions)
                .iter()
                .map(|(id, s)| SessionInfo {
                    session_id: id.clone(),
                    cwd: lock_or_recover(s).cwd.clone(),
                })
                .collect();
            reply(ServerOp::ListOk { sessions: infos });
        }

        ClientOp::Subscribe { session_id } => {
            let Some(session) = lock_or_recover(sessions).get(&session_id).cloned() else {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            };
            let cwd = {
                let mut s = lock_or_recover(&session);
                s.subscribers.push(tx.clone());
                s.cwd.clone()
            };
            reply(ServerOp::Ok);
            // Hydrate the client with the session's current cwd so its tab
            // label renders correctly on reattach without waiting for the
            // next prompt mark.
            let _ = tx.send(ServerMsg {
                id: None,
                op: ServerOp::Cwd { session_id, cwd },
            });
        }
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // One panicked worker should not poison the daemon's shared session state.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
