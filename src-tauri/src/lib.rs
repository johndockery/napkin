use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use uuid::Uuid;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, Arc<Mutex<PtySession>>>>,
}

#[derive(Serialize, Clone)]
struct PtyOutput {
    session_id: String,
    data: Vec<u8>,
}

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
fn pty_spawn(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    args: SpawnArgs,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = args
        .shell
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("NAPKIN", "1");
    if let Some(cwd) = args.cwd {
        cmd.cwd(cwd);
    } else if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

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

    let session_id = Uuid::new_v4().to_string();
    let session = Arc::new(Mutex::new(PtySession {
        master: pair.master,
        writer,
    }));

    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    // Reader thread: PTY bytes → pty-output events
    let emit_app = app.clone();
    let emit_id = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = emit_app.emit(
                        "pty-output",
                        PtyOutput {
                            session_id: emit_id.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let _ = emit_app.emit(
            "pty-exit",
            serde_json::json!({ "session_id": emit_id }),
        );
    });

    // Reap child in its own thread
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(session_id)
}

#[tauri::command]
fn pty_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?
        .clone();
    drop(sessions);
    let mut s = session.lock().unwrap();
    s.writer
        .write_all(&data)
        .map_err(|e| format!("write failed: {e}"))?;
    s.writer.flush().ok();
    Ok(())
}

#[tauri::command]
fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?
        .clone();
    drop(sessions);
    let s = session.lock().unwrap();
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running napkin");
}
