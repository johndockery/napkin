//! napkind — the napkin workspace daemon.
//!
//! Listens on a unix socket. One PTY multiplexer, many clients.

mod osc;
mod session;
mod shim;
mod storage;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use napkin_proto::{
    socket_path, ClientMsg, ClientOp, HistoryMatch, ServerMsg, ServerOp, SessionInfo,
};
use portable_pty::PtySize;

use session::{spawn_session, Session};
use storage::Storage;

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
    let hibernated: Arc<Mutex<HashMap<String, session::HibernatedSession>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let storage = Arc::new(match Storage::open() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkind: storage open failed: {e} — persistence disabled");
            Storage::disconnected()
        }
    });

    // Rehydrate sessions seen in the last 14 days so `napkin list` after a
    // restart still shows recent work. They don't have live PTYs yet —
    // Subscribe wakes them up lazily.
    {
        let sessions_snapshot = lock_or_recover(&sessions);
        let mut hib = lock_or_recover(&hibernated);
        for stored in storage.load_recent_sessions(14 * 24 * 60 * 60 * 1000) {
            if sessions_snapshot.contains_key(&stored.id) || hib.contains_key(&stored.id) {
                continue;
            }
            hib.insert(
                stored.id.clone(),
                session::HibernatedSession { cwd: stored.cwd },
            );
        }
        let count = hib.len();
        if count > 0 {
            eprintln!("napkind: rehydrated {count} hibernated session(s) from disk");
        }
    }

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let sessions = sessions.clone();
                let hibernated = hibernated.clone();
                let storage = storage.clone();
                thread::spawn(move || handle_client(stream, sessions, hibernated, storage));
            }
            Err(e) => {
                eprintln!("napkind: accept error: {e}");
            }
        }
    }
}

fn handle_client(
    stream: UnixStream,
    sessions: SessionMap,
    hibernated: Arc<Mutex<HashMap<String, session::HibernatedSession>>>,
    storage: Arc<Storage>,
) {
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
                Ok(msg) => dispatch(msg, &sessions, &hibernated, &tx, &storage),
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

fn dispatch(
    msg: ClientMsg,
    sessions: &SessionMap,
    hibernated: &Arc<Mutex<HashMap<String, session::HibernatedSession>>>,
    tx: &std::sync::mpsc::Sender<ServerMsg>,
    storage: &Arc<Storage>,
) {
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
        } => match spawn_session(rows, cols, cwd, shell, tx.clone(), storage.clone()) {
            Ok((sid, session)) => {
                {
                    let cwd = lock_or_recover(&session).cwd.clone();
                    storage.record_session(&sid, &cwd);
                }
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
            let mut infos: Vec<SessionInfo> = lock_or_recover(sessions)
                .iter()
                .map(|(id, s)| SessionInfo {
                    session_id: id.clone(),
                    cwd: lock_or_recover(s).cwd.clone(),
                })
                .collect();
            for (id, hib) in lock_or_recover(hibernated).iter() {
                infos.push(SessionInfo {
                    session_id: id.clone(),
                    cwd: hib.cwd.clone(),
                });
            }
            reply(ServerOp::ListOk { sessions: infos });
        }

        ClientOp::SearchHistory { query, limit } => {
            let limit = limit.unwrap_or(200).min(1000);
            let rows = storage.search_commands(&query, limit);
            let matches: Vec<HistoryMatch> = rows
                .into_iter()
                .map(|r| HistoryMatch {
                    session_id: r.session_id,
                    cwd: r.cwd,
                    cmd: r.cmd,
                    started_at_ms: r.started_at_ms,
                    ended_at_ms: r.ended_at_ms,
                    exit_code: r.exit_code,
                })
                .collect();
            reply(ServerOp::HistoryResults { matches });
        }

        ClientOp::AgentState {
            session_id,
            state,
            agent,
        } => {
            let exists = lock_or_recover(sessions).contains_key(&session_id);
            if !exists {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            }
            // Broadcast to every subscriber of this session via the first
            // one's channel; the session forwarder loop fans it out.
            let Some(session) = lock_or_recover(sessions).get(&session_id).cloned() else {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            };
            let msg = ServerMsg {
                id: None,
                op: ServerOp::Status {
                    session_id,
                    state,
                    agent,
                },
            };
            {
                let mut s = lock_or_recover(&session);
                s.subscribers.retain(|sub| sub.send(msg.clone()).is_ok());
            }
            reply(ServerOp::Ok);
        }

        ClientOp::Subscribe { session_id } => {
            // Is it a live session?
            let live = lock_or_recover(sessions).get(&session_id).cloned();
            let session = match live {
                Some(s) => s,
                None => {
                    // Is it hibernated — waiting to be resurrected?
                    let cwd = {
                        let mut hib = lock_or_recover(hibernated);
                        hib.remove(&session_id).map(|h| h.cwd)
                    };
                    let Some(cwd) = cwd else {
                        reply(ServerOp::Err {
                            error: "no such session".into(),
                        });
                        return;
                    };
                    // Spawn a fresh PTY at the stored cwd and adopt the old
                    // session id. Any prior scrollback we had on disk gets
                    // replayed below.
                    match session::resurrect_session(
                        session_id.clone(),
                        cwd,
                        tx.clone(),
                        storage.clone(),
                    ) {
                        Ok(s) => {
                            lock_or_recover(sessions).insert(session_id.clone(), s.clone());
                            s
                        }
                        Err(e) => {
                            reply(ServerOp::Err { error: e });
                            return;
                        }
                    }
                }
            };
            let (cwd, in_memory_scroll) = {
                let mut s = lock_or_recover(&session);
                s.subscribers.push(tx.clone());
                (s.cwd.clone(), s.scrollback.clone())
            };
            reply(ServerOp::Ok);
            // Prefer in-memory ring; fall back to whatever SQLite has on
            // disk (the typical resurrection case).
            let replay = if !in_memory_scroll.is_empty() {
                in_memory_scroll
            } else {
                storage.load_scrollback(&session_id, session::SCROLLBACK_LIMIT)
            };
            if !replay.is_empty() {
                let _ = tx.send(ServerMsg {
                    id: None,
                    op: ServerOp::Output {
                        session_id: session_id.clone(),
                        data: replay,
                    },
                });
            }
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
