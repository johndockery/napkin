use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use uuid::Uuid;

// ---------- Shell integration shim (zsh) ----------

const ZSH_ZSHENV: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zshenv" ]] && . "$HOME/.zshenv"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir
"#;

const ZSH_ZPROFILE: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zprofile" ]] && . "$HOME/.zprofile"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir
"#;

const ZSH_ZSHRC: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zshrc" ]] && . "$HOME/.zshrc"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir

# OSC 133 (prompt/command boundaries) + OSC 7 (cwd) hooks
autoload -Uz add-zsh-hook 2>/dev/null

__napkin_preexec() { printf '\e]133;C;\a' }
__napkin_precmd() {
  local ec=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' \
    "$ec" "${HOST:-${HOSTNAME:-localhost}}" "$PWD"
}
add-zsh-hook preexec __napkin_preexec 2>/dev/null
add-zsh-hook precmd  __napkin_precmd  2>/dev/null

printf '\e]133;A\a\e]7;file://%s%s\a' \
  "${HOST:-${HOSTNAME:-localhost}}" "$PWD"

# Don't leak our shim dir to subshells
unset ZDOTDIR
"#;

fn ensure_zsh_shim() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join(".local/share/napkin/zsh");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zshenv"), ZSH_ZSHENV).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zprofile"), ZSH_ZPROFILE).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zshrc"), ZSH_ZSHRC).map_err(|e| e.to_string())?;
    Ok(dir)
}

// ---------- OSC scanner ----------

#[derive(Debug)]
enum OscEvent {
    Cwd(String),
    PromptStart,
    CommandStart,
    CommandEnd(Option<i32>),
}

struct OscScanner {
    buf: Vec<u8>,
    in_osc: bool,
    saw_esc: bool,
}

impl OscScanner {
    fn new() -> Self {
        Self { buf: Vec::new(), in_osc: false, saw_esc: false }
    }

    fn feed(&mut self, data: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in data {
            if !self.in_osc {
                if self.saw_esc && b == b']' {
                    self.in_osc = true;
                    self.saw_esc = false;
                    self.buf.clear();
                } else if b == 0x1B {
                    self.saw_esc = true;
                } else {
                    self.saw_esc = false;
                }
            } else if b == 0x07 {
                if let Some(ev) = parse_osc(&self.buf) { events.push(ev); }
                self.buf.clear();
                self.in_osc = false;
                self.saw_esc = false;
            } else if self.saw_esc && b == b'\\' {
                if let Some(ev) = parse_osc(&self.buf) { events.push(ev); }
                self.buf.clear();
                self.in_osc = false;
                self.saw_esc = false;
            } else if b == 0x1B {
                self.saw_esc = true;
            } else {
                self.saw_esc = false;
                if self.buf.len() < 4096 {
                    self.buf.push(b);
                }
            }
        }
        events
    }
}

fn parse_osc(payload: &[u8]) -> Option<OscEvent> {
    let s = std::str::from_utf8(payload).ok()?;
    let (ident, rest) = s.split_once(';').unwrap_or((s, ""));
    match ident {
        "7" => {
            // file://host/path
            let path = rest.strip_prefix("file://").unwrap_or(rest);
            let path = path.find('/').map(|i| &path[i..]).unwrap_or(path);
            Some(OscEvent::Cwd(path.to_string()))
        }
        "133" => {
            let mut parts = rest.split(';');
            match parts.next()? {
                "A" | "B" => Some(OscEvent::PromptStart),
                "C" => Some(OscEvent::CommandStart),
                "D" => Some(OscEvent::CommandEnd(parts.next().and_then(|s| s.parse().ok()))),
                _ => None,
            }
        }
        _ => None,
    }
}

// ---------- Session state ----------

#[derive(Clone, Debug, Serialize)]
struct CommandRecord {
    started_at_ms: u128,
    ended_at_ms: Option<u128>,
    exit_code: Option<i32>,
    cwd: String,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    cwd: String,
    command_log: Vec<CommandRecord>,
    current: Option<CommandRecord>,
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

// ---------- Commands ----------

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
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

    let is_zsh = shell.ends_with("/zsh") || shell == "zsh";
    if is_zsh {
        match ensure_zsh_shim() {
            Ok(dir) => { cmd.env("ZDOTDIR", dir); }
            Err(e) => eprintln!("napkin: shell integration install failed: {e}"),
        }
    }

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
        cwd: std::env::var("HOME").unwrap_or_default(),
        command_log: Vec::new(),
        current: None,
    }));

    state.sessions.lock().unwrap().insert(session_id.clone(), session.clone());

    // Reader thread: forward bytes + scan OSC
    let emit_app = app.clone();
    let emit_id = session_id.clone();
    let session_for_thread = session.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut scanner = OscScanner::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let _ = emit_app.emit(
                        "pty-output",
                        PtyOutput { session_id: emit_id.clone(), data: data.clone() },
                    );
                    for ev in scanner.feed(&data) {
                        handle_osc_event(&emit_app, &emit_id, &session_for_thread, ev);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = emit_app.emit(
            "pty-exit",
            serde_json::json!({ "session_id": emit_id }),
        );
    });

    std::thread::spawn(move || { let _ = child.wait(); });

    Ok(session_id)
}

fn handle_osc_event(
    app: &tauri::AppHandle,
    session_id: &str,
    session: &Arc<Mutex<PtySession>>,
    ev: OscEvent,
) {
    match ev {
        OscEvent::Cwd(cwd) => {
            {
                let mut s = session.lock().unwrap();
                s.cwd = cwd.clone();
            }
            let _ = app.emit("pane-cwd", serde_json::json!({
                "session_id": session_id, "cwd": cwd
            }));
        }
        OscEvent::PromptStart => {
            // Marks end of a command / start of a new prompt.
            // Nothing to do beyond CommandEnd's record-finalisation.
        }
        OscEvent::CommandStart => {
            let mut s = session.lock().unwrap();
            let cwd = s.cwd.clone();
            s.current = Some(CommandRecord {
                started_at_ms: now_ms(),
                ended_at_ms: None,
                exit_code: None,
                cwd,
            });
        }
        OscEvent::CommandEnd(exit_code) => {
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
    }
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
    s.writer.write_all(&data).map_err(|e| format!("write failed: {e}"))?;
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
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

#[tauri::command]
fn pty_command_log(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<CommandRecord>, String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?
        .clone();
    drop(sessions);
    let log = session.lock().unwrap().command_log.clone();
    Ok(log)
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
            pty_command_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running napkin");
}
