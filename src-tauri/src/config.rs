//! User config loader.
//!
//! Reads `~/.config/napkin/config.toml` (or `$XDG_CONFIG_HOME/napkin/...`)
//! and produces a merged `serde_json::Value` the frontend consumes. TOML is
//! the documented format; `config.json` is still read as a fallback for
//! anyone who hand-wrote JSON against earlier builds.
//!
//! The loader is deliberately forgiving: unknown keys are preserved (the
//! frontend decides what to do with them), missing keys fall back to
//! compiled-in defaults, and malformed files surface a warning instead of
//! refusing to boot.
//!
//! Hot reload: `spawn_config_watcher` watches the config directory via
//! `notify` and emits a `config-changed` Tauri event carrying the freshly
//! loaded value.

use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const DEFAULT_TEMPLATE: &str = include_str!("../../docs/config.default.toml");

/// Resolved path to the primary config file (TOML).
pub(crate) fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

/// Legacy JSON path, read if present and TOML is missing.
fn legacy_json_path() -> PathBuf {
    config_dir().join("config.json")
}

fn config_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("napkin");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/napkin")
}

/// Merge user input on top of the compiled-in defaults. Unknown keys are
/// carried through untouched so schema additions don't require a Rust rebuild.
#[tauri::command]
pub(crate) fn load_config() -> Value {
    let mut merged = default_config();
    if let Some(user) = read_user_config() {
        deep_merge(&mut merged, user);
    }
    merged
}

/// Path-typed helpers for the frontend so it doesn't have to know about XDG.
#[tauri::command]
pub(crate) fn config_path_string() -> String {
    config_path().to_string_lossy().into_owned()
}

/// Ensure the config file exists, returning its path. Writes the annotated
/// default template on first creation so users have something to edit.
#[tauri::command]
pub(crate) fn config_ensure() -> Result<String, String> {
    let path = config_path();
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, DEFAULT_TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Open the config in $EDITOR (falling back to `open` on macOS). Creates it
/// if it doesn't yet exist.
#[tauri::command]
pub(crate) fn config_open() -> Result<(), String> {
    use std::process::{Command, Stdio};

    let path = config_ensure()?;

    let editor = std::env::var("EDITOR").unwrap_or_default();
    let bin = editor
        .split_whitespace()
        .next()
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
        .unwrap_or_default();

    let spawn = |cmd: &mut Command| -> Result<(), String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    };

    match bin.as_str() {
        "code" | "code-insiders" | "cursor" | "windsurf" => {
            let mut c = Command::new(&bin);
            c.arg(&path);
            spawn(&mut c)
        }
        "" => {
            // Route to the user's default app for .toml — usually an editor.
            let mut c = Command::new("open");
            c.arg(&path);
            spawn(&mut c)
        }
        _ => {
            let mut c = Command::new(&bin);
            c.arg(&path);
            spawn(&mut c)
        }
    }
}

/// Reveal the config file in Finder (macOS) or the XDG file manager.
#[tauri::command]
pub(crate) fn config_reveal() -> Result<(), String> {
    use std::process::{Command, Stdio};
    let path = config_ensure()?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg("-R").arg(&path);
        c
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(std::path::Path::new(&path).parent().unwrap_or_else(|| std::path::Path::new("/")));
        c
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Write a fresh default template to the config path, moving any existing
/// file aside with a timestamp suffix. Used by "reset to defaults".
#[tauri::command]
pub(crate) fn config_reset() -> Result<String, String> {
    let path = config_path();
    if path.exists() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_extension(format!("toml.bak.{suffix}"));
        std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
    } else if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, DEFAULT_TEMPLATE).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Start a background thread watching the config file and its parent
/// directory for changes, re-loading and emitting `config-changed` on each
/// settled change.
pub(crate) fn spawn_config_watcher(app: AppHandle) {
    let path = config_path();
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));

    thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("napkin: failed to init config watcher: {e}");
                return;
            }
        };

        let _ = std::fs::create_dir_all(&dir);
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("napkin: failed to watch {}: {e}", dir.display());
            return;
        }

        // Simple debounce: wait for events to stop arriving for 250ms before
        // re-reading. Handles editors that save via rename+truncate, which
        // otherwise fires 3+ events per save.
        let debounce = Duration::from_millis(250);
        let mut pending: Option<Instant> = None;

        loop {
            let recv_deadline = pending.map(|t| t + debounce);
            let event = match recv_deadline {
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        rx.try_recv().ok()
                    } else {
                        rx.recv_timeout(deadline - now).ok()
                    }
                }
                None => rx.recv().ok(),
            };

            match event {
                Some(Ok(ev)) => {
                    if event_touches(&ev, &path) {
                        pending = Some(Instant::now());
                    }
                }
                Some(Err(e)) => eprintln!("napkin: config watcher: {e}"),
                None => {
                    if let Some(t) = pending {
                        if t.elapsed() >= debounce {
                            pending = None;
                            let value = load_config();
                            let _ = app.emit("config-changed", value);
                        }
                    }
                }
            }
        }
    });
}

fn event_touches(ev: &notify::Event, path: &Path) -> bool {
    ev.paths.iter().any(|p| {
        p == path
            || p.file_name() == path.file_name()
            || p.extension().and_then(|e| e.to_str()) == Some("toml")
            || p.extension().and_then(|e| e.to_str()) == Some("json")
    })
}

fn read_user_config() -> Option<Value> {
    let toml_path = config_path();
    if let Ok(content) = std::fs::read_to_string(&toml_path) {
        match toml::from_str::<toml::Value>(&content) {
            Ok(parsed) => return Some(toml_to_json(parsed)),
            Err(e) => {
                eprintln!(
                    "napkin: {} is not valid TOML, falling back to defaults: {e}",
                    toml_path.display()
                );
            }
        }
    }

    let json_path = legacy_json_path();
    if let Ok(content) = std::fs::read_to_string(&json_path) {
        match serde_json::from_str::<Value>(&content) {
            Ok(parsed) => return Some(parsed),
            Err(e) => {
                eprintln!(
                    "napkin: {} is not valid JSON, falling back to defaults: {e}",
                    json_path.display()
                );
            }
        }
    }

    None
}

fn toml_to_json(v: toml::Value) -> Value {
    match v {
        toml::Value::String(s) => Value::String(s),
        toml::Value::Integer(i) => Value::Number(i.into()),
        toml::Value::Float(f) => {
            serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
        }
        toml::Value::Boolean(b) => Value::Bool(b),
        toml::Value::Datetime(d) => Value::String(d.to_string()),
        toml::Value::Array(a) => Value::Array(a.into_iter().map(toml_to_json).collect()),
        toml::Value::Table(t) => {
            let mut map = serde_json::Map::with_capacity(t.len());
            for (k, v) in t {
                map.insert(k, toml_to_json(v));
            }
            Value::Object(map)
        }
    }
}

fn deep_merge(dest: &mut Value, src: Value) {
    match (dest, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (k, v) in s {
                match d.get_mut(&k) {
                    Some(existing) => deep_merge(existing, v),
                    None => {
                        d.insert(k, v);
                    }
                }
            }
        }
        (dest_slot, src_value) => {
            *dest_slot = src_value;
        }
    }
}

fn default_config() -> Value {
    json!({
        "shell": {
            "program": null,
            "args": [],
            "env": {},
            "cwd": null
        },
        "window": {
            "opacity": 1.0,
            "blur": true,
            "padding": 8
        },
        "terminal": {
            "font_family": "JetBrains Mono, SF Mono, Menlo, monospace",
            "font_size": 14,
            "line_height": 1.35,
            "letter_spacing": 0.0,
            "cursor_style": "bar",
            "cursor_blink": true,
            "scrollback": 10000,
            "bell": "none",
            "copy_on_select": false,
            "theme": {
                "background": "rgba(0,0,0,0)",
                "foreground": "#e6e6e6",
                "cursor": "#fefbf4",
                "cursor_accent": "#0b0c0f",
                "selection_background": "rgba(254, 251, 244, 0.22)",
                "selection_foreground": "#ffffff",
                "black": "#1c1c1c",
                "red": "#e06c75",
                "green": "#98c379",
                "yellow": "#e5c07b",
                "blue": "#61afef",
                "magenta": "#c678dd",
                "cyan": "#56b6c2",
                "white": "#dcdfe4",
                "bright_black": "#5c6370",
                "bright_red": "#e06c75",
                "bright_green": "#98c379",
                "bright_yellow": "#e5c07b",
                "bright_blue": "#61afef",
                "bright_magenta": "#c678dd",
                "bright_cyan": "#56b6c2",
                "bright_white": "#ffffff"
            }
        },
        "tabs": {
            "color_by_command": {}
        },
        "agents": {
            "detect": true,
            "notify_on": ["waiting", "error"],
            "cost_budget_usd": 0.0
        },
        "keybindings": {},
        "integrations": {
            "editor": null,
            "diff_tool": null
        }
    })
}
