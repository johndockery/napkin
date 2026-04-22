//! Tauri command handlers. These preserve the existing invoke surface exactly.

use napkin_proto::{ClientOp, HistoryMatch, ServerOp, SessionInfo};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::client::Client;

#[derive(Serialize)]
pub(crate) struct PtySession {
    session_id: String,
    cwd: String,
}

impl From<SessionInfo> for PtySession {
    fn from(info: SessionInfo) -> Self {
        Self {
            session_id: info.session_id,
            cwd: info.cwd,
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct SpawnArgs {
    rows: u16,
    cols: u16,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    shell: Option<String>,
}

#[tauri::command]
pub(crate) fn pty_spawn(client: State<'_, Client>, args: SpawnArgs) -> Result<String, String> {
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
pub(crate) fn pty_write(
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
pub(crate) fn pty_resize(
    client: State<'_, Client>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    match client.request(ClientOp::Resize {
        session_id,
        rows,
        cols,
    })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
pub(crate) fn pty_kill(client: State<'_, Client>, session_id: String) -> Result<(), String> {
    match client.request(ClientOp::Kill { session_id })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[derive(Serialize)]
pub(crate) struct HistoryEntry {
    session_id: String,
    cwd: String,
    cmd: String,
    started_at_ms: i64,
    ended_at_ms: Option<i64>,
    exit_code: Option<i32>,
}

impl From<HistoryMatch> for HistoryEntry {
    fn from(m: HistoryMatch) -> Self {
        Self {
            session_id: m.session_id,
            cwd: m.cwd,
            cmd: m.cmd,
            started_at_ms: m.started_at_ms,
            ended_at_ms: m.ended_at_ms,
            exit_code: m.exit_code,
        }
    }
}

#[tauri::command]
pub(crate) fn search_history(
    client: State<'_, Client>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    match client.request(ClientOp::SearchHistory { query, limit })? {
        ServerOp::HistoryResults { matches } => {
            Ok(matches.into_iter().map(Into::into).collect())
        }
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
pub(crate) fn pty_list(client: State<'_, Client>) -> Result<Vec<PtySession>, String> {
    match client.request(ClientOp::List)? {
        ServerOp::ListOk { sessions } => Ok(sessions.into_iter().map(Into::into).collect()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

/// Open a file path (optionally with line/column) in the user's editor.
/// Honours $EDITOR via `-g` syntax when it looks like vscode/cursor; falls
/// back to `open` on macOS otherwise.
#[tauri::command]
pub(crate) fn open_in_editor(
    path: String,
    #[allow(non_snake_case)] line: Option<u32>,
    #[allow(non_snake_case)] column: Option<u32>,
) -> Result<(), String> {
    use std::process::Command;

    let editor = std::env::var("EDITOR").unwrap_or_default();
    let editor_bin = editor
        .split_whitespace()
        .next()
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
        .unwrap_or_default();

    // Build the target path with line:col suffix if we have one.
    let target = match (line, column) {
        (Some(l), Some(c)) => format!("{path}:{l}:{c}"),
        (Some(l), None) => format!("{path}:{l}"),
        _ => path.clone(),
    };

    let spawn = |cmd: &mut Command| {
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    };

    match editor_bin.as_str() {
        "code" | "code-insiders" | "cursor" | "windsurf" => {
            let mut c = Command::new(&editor_bin);
            c.arg("-g").arg(&target);
            spawn(&mut c)
        }
        "" => {
            // No $EDITOR configured; fall back to macOS `open`, which routes
            // to the user's default editor association.
            let mut c = Command::new("open");
            c.arg(&path);
            spawn(&mut c)
        }
        _ => {
            // Generic $EDITOR invocation. Some editors support +line;
            // include it only when we have a line.
            let mut c = Command::new(&editor_bin);
            if let Some(l) = line {
                c.arg(format!("+{l}"));
            }
            c.arg(&path);
            spawn(&mut c)
        }
    }
}

/// Re-attach the UI to an existing daemon session and resize it to the
/// caller's window dimensions.
#[tauri::command]
pub(crate) fn pty_subscribe(
    client: State<'_, Client>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    // Only send a Subscribe op on the first subscribe for this session in
    // this Tauri process lifetime. HMR page reloads re-run the boot path and
    // would otherwise append the same client tx to the daemon's subscriber
    // list again, multiplying every Output event back to us.
    if client.mark_subscribed(&session_id) {
        match client.request(ClientOp::Subscribe {
            session_id: session_id.clone(),
        })? {
            ServerOp::Ok => {}
            ServerOp::Err { error } => return Err(error),
            other => return Err(format!("unexpected reply: {other:?}")),
        }
    }
    // Always resize — the window may have changed size across the reload.
    match client.request(ClientOp::Resize {
        session_id,
        rows,
        cols,
    })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}
