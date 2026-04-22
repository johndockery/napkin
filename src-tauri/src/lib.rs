//! napkin UI core. Thin client over the napkind unix-socket daemon.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use napkin_proto::{
    socket_path, ClientMsg, ClientOp, ServerMsg, ServerOp,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};

// ---------- Client connection to napkind ----------

struct Client {
    tx: Sender<ClientMsg>,
    pending: Arc<Mutex<HashMap<u64, Sender<ServerOp>>>>,
    next_id: AtomicU64,
}

impl Client {
    fn request(&self, op: ClientOp) -> Result<ServerOp, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (reply_tx, reply_rx) = channel::<ServerOp>();
        self.pending.lock().unwrap().insert(id, reply_tx);
        self.tx
            .send(ClientMsg { id: Some(id), op })
            .map_err(|e| e.to_string())?;
        match reply_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(resp) => Ok(resp),
            Err(e) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("napkind reply timeout: {e}"))
            }
        }
    }
}

fn find_napkind() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let cand = parent.join("napkind");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}

fn ensure_napkind_running(socket: &std::path::Path) -> Result<UnixStream, String> {
    // 1. Try connecting to an already-running daemon
    if let Ok(s) = UnixStream::connect(socket) {
        return Ok(s);
    }
    // 2. Spawn a new one
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
    spawn_result.map_err(|e| format!("spawn napkind: {e}"))?;
    // 3. Wait for it to come up (up to ~5s)
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(s) = UnixStream::connect(socket) {
            return Ok(s);
        }
    }
    Err("napkind did not start in time".into())
}

fn start_client(app: AppHandle) -> Result<Client, String> {
    let stream = ensure_napkind_running(&socket_path())?;
    let read_stream = stream.try_clone().map_err(|e| e.to_string())?;
    let mut write_stream = stream;

    let (tx, rx) = channel::<ClientMsg>();
    let pending: Arc<Mutex<HashMap<u64, Sender<ServerOp>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Writer thread
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            let Ok(line) = serde_json::to_string(&msg) else { continue };
            if writeln!(write_stream, "{}", line).is_err() {
                break;
            }
        }
    });

    // Reader thread
    let pending_for_reader = pending.clone();
    let app_for_reader = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(read_stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<ServerMsg>(&line) else { continue };
            if let Some(id) = msg.id {
                if let Some(slot) = pending_for_reader.lock().unwrap().remove(&id) {
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
    })
}

fn dispatch_event(app: &AppHandle, op: ServerOp) {
    match op {
        ServerOp::Output { session_id, data } => {
            let _ = app.emit(
                "pty-output",
                serde_json::json!({ "session_id": session_id, "data": data }),
            );
        }
        ServerOp::Exit { session_id } => {
            let _ = app.emit(
                "pty-exit",
                serde_json::json!({ "session_id": session_id }),
            );
        }
        ServerOp::Cwd { session_id, cwd } => {
            let _ = app.emit(
                "pane-cwd",
                serde_json::json!({ "session_id": session_id, "cwd": cwd }),
            );
        }
        ServerOp::Mark { session_id, mark, exit } => {
            let _ = app.emit(
                "pane-mark",
                serde_json::json!({ "session_id": session_id, "mark": mark, "exit": exit }),
            );
        }
        _ => {}
    }
}

// ---------- Tauri commands ----------

#[derive(Deserialize)]
struct SpawnArgs {
    rows: u16,
    cols: u16,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
}

#[tauri::command]
fn pty_spawn(client: State<'_, Client>, args: SpawnArgs) -> Result<String, String> {
    match client.request(ClientOp::Spawn {
        rows: args.rows,
        cols: args.cols,
        cwd: args.cwd,
        shell: args.shell,
    })? {
        ServerOp::SpawnOk { session_id } => Ok(session_id),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
fn pty_write(
    client: State<'_, Client>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    match client.request(ClientOp::Write { session_id, data })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
fn pty_resize(
    client: State<'_, Client>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    match client.request(ClientOp::Resize { session_id, rows, cols })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
fn pty_kill(client: State<'_, Client>, session_id: String) -> Result<(), String> {
    match client.request(ClientOp::Kill { session_id })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

// ---------- Entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            match start_client(handle) {
                Ok(client) => { app.manage(client); }
                Err(e) => {
                    eprintln!("napkin: failed to connect to napkind: {e}");
                    // Manage a dummy so invoke calls surface a clean error.
                    let (dead_tx, _dead_rx) = channel::<ClientMsg>();
                    app.manage(Client {
                        tx: dead_tx,
                        pending: Arc::new(Mutex::new(HashMap::new())),
                        next_id: AtomicU64::new(0),
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running napkin");
}
