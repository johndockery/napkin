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
use std::time::Duration;

use napkin_proto::{
    socket_path, ClientMsg, ClientOp, HistoryMatch, ServerMsg, ServerOp, SessionInfo,
};
use portable_pty::PtySize;

use session::{spawn_session, Session};
use storage::Storage;

type SessionMap = Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>;
/// diff_id → (cli's reply channel, cli's request id). Set on DiffPreview,
/// drained on DiffDecision.
type DiffWaiters = Arc<Mutex<HashMap<String, (std::sync::mpsc::Sender<ServerMsg>, Option<u64>)>>>;

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
    let diff_waiters: DiffWaiters = Arc::new(Mutex::new(HashMap::new()));
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
                let diff_waiters = diff_waiters.clone();
                thread::spawn(move || {
                    handle_client(stream, sessions, hibernated, storage, diff_waiters)
                });
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
    diff_waiters: DiffWaiters,
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
                Ok(msg) => dispatch(msg, &sessions, &hibernated, &tx, &storage, &diff_waiters),
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
    diff_waiters: &DiffWaiters,
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
            shell_args,
            env,
        } => match spawn_session(
            rows,
            cols,
            cwd,
            shell,
            shell_args,
            env,
            tx.clone(),
            storage.clone(),
        ) {
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
            reply(kill_session(sessions, hibernated, storage, &session_id));
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

        ClientOp::DiffPreview {
            session_id,
            diff_id,
            diff,
            title,
        } => {
            let Some(session) = lock_or_recover(sessions).get(&session_id).cloned() else {
                reply(ServerOp::Err {
                    error: "no such session".into(),
                });
                return;
            };
            // Park the CLI's reply channel — we'll send DiffResolved back
            // with its original request id once a UI client decides.
            lock_or_recover(diff_waiters).insert(diff_id.clone(), (tx.clone(), id));
            let prompt = ServerMsg {
                id: None,
                op: ServerOp::DiffPrompt {
                    session_id,
                    diff_id,
                    diff,
                    title,
                },
            };
            {
                let mut s = lock_or_recover(&session);
                s.subscribers.retain(|sub| sub.send(prompt.clone()).is_ok());
            }
            // Don't reply here — we wait for DiffDecision.
        }

        ClientOp::PauseSession { session_id } => {
            reply(signal_session(sessions, &session_id, libc::SIGSTOP));
        }

        ClientOp::ResumeSession { session_id } => {
            reply(signal_session(sessions, &session_id, libc::SIGCONT));
        }

        ClientOp::DiffDecision { diff_id, accepted } => {
            let waiter = lock_or_recover(diff_waiters).remove(&diff_id);
            if let Some((waiter_tx, waiter_id)) = waiter {
                let _ = waiter_tx.send(ServerMsg {
                    id: waiter_id,
                    op: ServerOp::DiffResolved { diff_id, accepted },
                });
            }
            reply(ServerOp::Ok);
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
            tokens,
            cost_usd,
        } => {
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
                    tokens,
                    cost_usd,
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

/// Send a signal to the shell process of a session.
fn signal_session(sessions: &SessionMap, session_id: &str, signal: libc::c_int) -> ServerOp {
    let Some(session) = lock_or_recover(sessions).get(session_id).cloned() else {
        return ServerOp::Err {
            error: "no such session".into(),
        };
    };
    let pid = {
        let s = lock_or_recover(&session);
        s.shell_pid
    };
    let Some(pid) = pid else {
        return ServerOp::Err {
            error: "session has no known shell pid".into(),
        };
    };
    // Safety: kill(2) is always safe to call.
    let rc = unsafe { libc::kill(pid as i32, signal) };
    if rc == 0 {
        ServerOp::Ok
    } else {
        let errno = std::io::Error::last_os_error();
        ServerOp::Err {
            error: format!("kill({pid}, {signal}) failed: {errno}"),
        }
    }
}

fn kill_session(
    sessions: &SessionMap,
    hibernated: &Arc<Mutex<HashMap<String, session::HibernatedSession>>>,
    storage: &Arc<Storage>,
    session_id: &str,
) -> ServerOp {
    if let Some(session) = lock_or_recover(sessions).get(session_id).cloned() {
        let kill_result = {
            let mut s = lock_or_recover(&session);
            s.discard_persistence = true;
            let result = terminate_session_processes(
                s.shell_pid.map(|pid| pid as libc::pid_t),
                s.master.process_group_leader(),
            );
            if result.is_err() {
                s.discard_persistence = false;
            }
            result
        };
        if let Err(error) = kill_result {
            return ServerOp::Err {
                error: format!("kill session failed: {error}"),
            };
        }

        lock_or_recover(sessions).remove(session_id);
        lock_or_recover(hibernated).remove(session_id);
        storage.forget_session(session_id);
        return ServerOp::Ok;
    }

    if lock_or_recover(hibernated).remove(session_id).is_some() {
        storage.forget_session(session_id);
        return ServerOp::Ok;
    }

    ServerOp::Err {
        error: "no such session".into(),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SignalTarget {
    Process(libc::pid_t),
    ProcessGroup(libc::pid_t),
}

impl SignalTarget {
    fn kill_arg(self) -> libc::pid_t {
        match self {
            Self::Process(pid) => pid,
            Self::ProcessGroup(pgid) => -pgid,
        }
    }
}

fn terminate_session_processes(
    shell_pid: Option<libc::pid_t>,
    foreground_group: Option<libc::pid_t>,
) -> std::io::Result<()> {
    let mut targets = Vec::new();
    if let Some(pgid) = foreground_group.filter(|pid| *pid > 0) {
        push_signal_target(&mut targets, SignalTarget::ProcessGroup(pgid));
    }
    if let Some(pid) = shell_pid.filter(|pid| *pid > 0) {
        push_signal_target(&mut targets, SignalTarget::ProcessGroup(pid));
        push_signal_target(&mut targets, SignalTarget::Process(pid));
    }
    if targets.is_empty() {
        return Ok(());
    }

    signal_targets(&targets, libc::SIGHUP)?;
    signal_targets(&targets, libc::SIGCONT)?;
    if wait_for_targets_exit(&targets, 6, Duration::from_millis(50)) {
        return Ok(());
    }

    signal_targets(&targets, libc::SIGTERM)?;
    signal_targets(&targets, libc::SIGCONT)?;
    if wait_for_targets_exit(&targets, 10, Duration::from_millis(50)) {
        return Ok(());
    }

    signal_targets(&targets, libc::SIGKILL)?;
    if wait_for_targets_exit(&targets, 10, Duration::from_millis(50)) {
        return Ok(());
    }

    Err(std::io::Error::other("timed out waiting for session to exit"))
}

fn push_signal_target(targets: &mut Vec<SignalTarget>, target: SignalTarget) {
    if !targets.contains(&target) {
        targets.push(target);
    }
}

fn signal_targets(targets: &[SignalTarget], signal: libc::c_int) -> std::io::Result<()> {
    let mut first_error: Option<std::io::Error> = None;
    for target in targets {
        // Safety: kill(2) is always safe to call.
        let rc = unsafe { libc::kill(target.kill_arg(), signal) };
        if rc == 0 {
            continue;
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            continue;
        }
        if first_error.is_none() {
            first_error = Some(error);
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn wait_for_targets_exit(targets: &[SignalTarget], attempts: usize, delay: Duration) -> bool {
    for attempt in 0..attempts {
        if !targets.iter().any(signal_target_alive) {
            return true;
        }
        if attempt + 1 < attempts {
            thread::sleep(delay);
        }
    }
    !targets.iter().any(signal_target_alive)
}

fn signal_target_alive(target: &SignalTarget) -> bool {
    // Safety: kill(2) is always safe to call.
    let rc = unsafe { libc::kill(target.kill_arg(), 0) };
    if rc == 0 {
        return true;
    }
    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EPERM)
    )
}
