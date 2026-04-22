//! Client bridge from the Tauri process to the `napkind` unix-socket daemon.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use napkin_proto::{socket_path, ClientMsg, ClientOp, ServerMsg, ServerOp};
use tauri::AppHandle;

use crate::events::dispatch_event;

type PendingReplies = Arc<Mutex<HashMap<u64, Sender<ServerOp>>>>;
type SubscribedSessions = Arc<Mutex<HashSet<String>>>;

pub(crate) struct Client {
    tx: Sender<ClientMsg>,
    pending: PendingReplies,
    next_id: AtomicU64,
    /// Sessions this Tauri process has already told napkind to subscribe to.
    /// Survives HMR page reloads, so a soft refresh can't append duplicate
    /// subscribers on the daemon and multiply Output events back to us.
    subscribed: SubscribedSessions,
}

impl Client {
    pub(crate) fn request(&self, op: ClientOp) -> Result<ServerOp, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = channel::<ServerOp>();
        lock_or_recover(&self.pending).insert(id, reply_tx);
        self.tx
            .send(ClientMsg { id: Some(id), op })
            .map_err(|error| error.to_string())?;

        match reply_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(response) => Ok(response),
            Err(error) => {
                lock_or_recover(&self.pending).remove(&id);
                Err(format!("napkind reply timeout: {error}"))
            }
        }
    }

    pub(crate) fn disconnected() -> Self {
        let (dead_tx, _dead_rx) = channel::<ClientMsg>();
        Self {
            tx: dead_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(0),
            subscribed: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Atomically record that this session has been subscribed and report
    /// whether the caller is the first subscriber for that id.
    pub(crate) fn mark_subscribed(&self, session_id: &str) -> bool {
        lock_or_recover(&self.subscribed).insert(session_id.to_string())
    }
}

pub(crate) fn start_client(app: AppHandle) -> Result<Client, String> {
    let stream = ensure_napkind_running(&socket_path())?;
    let read_stream = stream.try_clone().map_err(|error| error.to_string())?;
    let mut write_stream = stream;

    let (tx, rx) = channel::<ClientMsg>();
    let pending: PendingReplies = Arc::new(Mutex::new(HashMap::new()));

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

    let pending_for_reader = pending.clone();
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

    Ok(Client {
        tx,
        pending,
        next_id: AtomicU64::new(1),
        subscribed: Arc::new(Mutex::new(HashSet::new())),
    })
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
