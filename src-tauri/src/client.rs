//! Client bridge from the Tauri process to the `napkind` unix-socket daemon.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use napkin_proto::{socket_path, ClientMsg, ClientOp, ServerMsg, ServerOp};
use tauri::AppHandle;

use crate::events::dispatch_event;

type PendingReplies = Arc<Mutex<HashMap<u64, Sender<ServerOp>>>>;
type SubscribedSessions = Arc<Mutex<HashSet<String>>>;

/// Upper bound a request will wait on the connection coming up before
/// returning a clean error. Generous — cold start may need to spawn napkind
/// and let it open its socket.
const CONNECT_WAIT: Duration = Duration::from_secs(15);
/// How long to wait for napkind to reply once a request has been sent.
const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

enum ConnState {
    Connecting,
    Connected(Sender<ClientMsg>),
    Failed(String),
}

struct ClientShared {
    state: Mutex<ConnState>,
    ready: Condvar,
    pending: PendingReplies,
    next_id: AtomicU64,
    /// Sessions this Tauri process has already told napkind to subscribe to.
    /// Survives HMR page reloads, so a soft refresh can't append duplicate
    /// subscribers on the daemon and multiply Output events back to us.
    subscribed: SubscribedSessions,
}

pub(crate) struct Client {
    shared: Arc<ClientShared>,
}

impl Client {
    /// Returns immediately. The unix-socket connection to napkind, including
    /// any spawn-and-wait for the daemon, runs on a worker thread; the Tauri
    /// setup hook (and therefore the main thread) never blocks on it. Calls
    /// to `request()` made before the worker finishes wait on a condvar.
    pub(crate) fn start(app: AppHandle) -> Self {
        let shared = Arc::new(ClientShared {
            state: Mutex::new(ConnState::Connecting),
            ready: Condvar::new(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
            subscribed: Arc::new(Mutex::new(HashSet::new())),
        });

        let worker = shared.clone();
        std::thread::spawn(move || {
            connect_and_wire(app, worker);
        });

        Self { shared }
    }

    pub(crate) fn request(&self, op: ClientOp) -> Result<ServerOp, String> {
        let tx = self.wait_for_sender()?;

        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = channel::<ServerOp>();
        lock_or_recover(&self.shared.pending).insert(id, reply_tx);
        tx.send(ClientMsg { id: Some(id), op })
            .map_err(|error| error.to_string())?;

        match reply_rx.recv_timeout(REPLY_TIMEOUT) {
            Ok(response) => Ok(response),
            Err(error) => {
                lock_or_recover(&self.shared.pending).remove(&id);
                Err(format!("napkind reply timeout: {error}"))
            }
        }
    }

    /// Atomically record that this session has been subscribed and report
    /// whether the caller is the first subscriber for that id.
    pub(crate) fn mark_subscribed(&self, session_id: &str) -> bool {
        lock_or_recover(&self.shared.subscribed).insert(session_id.to_string())
    }

    fn wait_for_sender(&self) -> Result<Sender<ClientMsg>, String> {
        let mut guard = lock_or_recover(&self.shared.state);
        loop {
            match &*guard {
                ConnState::Connected(tx) => return Ok(tx.clone()),
                ConnState::Failed(err) => return Err(err.clone()),
                ConnState::Connecting => {
                    let (next, timeout) = self
                        .shared
                        .ready
                        .wait_timeout(guard, CONNECT_WAIT)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    if timeout.timed_out() {
                        return Err("napkind: still connecting".to_string());
                    }
                    guard = next;
                }
            }
        }
    }
}

fn connect_and_wire(app: AppHandle, shared: Arc<ClientShared>) {
    let stream = match ensure_napkind_running(&socket_path()) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("napkin: failed to connect to napkind: {error}");
            *lock_or_recover(&shared.state) = ConnState::Failed(error);
            shared.ready.notify_all();
            return;
        }
    };

    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(error) => {
            let msg = error.to_string();
            eprintln!("napkin: failed to clone napkind stream: {msg}");
            *lock_or_recover(&shared.state) = ConnState::Failed(msg);
            shared.ready.notify_all();
            return;
        }
    };
    let mut write_stream = stream;

    let (tx, rx) = channel::<ClientMsg>();

    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            let Ok(line) = serde_json::to_string(&msg) else {
                continue;
            };
            if writeln!(write_stream, "{line}").is_err() {
                break;
            }
        }
    });

    let pending_for_reader = shared.pending.clone();
    let app_for_reader = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(read_stream);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(msg) = serde_json::from_str::<ServerMsg>(&line) else {
                continue;
            };

            if let Some(id) = msg.id {
                if let Some(slot) = lock_or_recover(&pending_for_reader).remove(&id) {
                    let _ = slot.send(msg.op);
                    continue;
                }
            }

            dispatch_event(&app_for_reader, msg.op);
        }
    });

    *lock_or_recover(&shared.state) = ConnState::Connected(tx);
    shared.ready.notify_all();
}

fn find_napkind() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("napkind");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn ensure_napkind_running(socket: &std::path::Path) -> Result<UnixStream, String> {
    if let Ok(stream) = UnixStream::connect(socket) {
        return Ok(stream);
    }

    let spawn_result = if let Some(path) = find_napkind() {
        Command::new(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    } else {
        Command::new("napkind")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    spawn_result.map_err(|error| format!("spawn napkind: {error}"))?;

    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(stream) = UnixStream::connect(socket) {
            return Ok(stream);
        }
    }

    Err("napkind did not start in time".into())
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic in one bridge thread should not permanently wedge the reply map.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
