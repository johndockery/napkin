//! Tauri command handlers. These preserve the existing invoke surface exactly.

use napkin_proto::{ClientOp, HistoryMatch, ServerOp, SessionInfo};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::client::Client;
use crate::editor::{spawn_detached, EditorCommand};

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
    #[serde(default)]
    shell_args: Vec<String>,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
}

#[tauri::command]
pub(crate) fn pty_spawn(client: State<'_, Client>, args: SpawnArgs) -> Result<String, String> {
    match client.request(ClientOp::Spawn {
        rows: args.rows,
        cols: args.cols,
        cwd: args.cwd,
        shell: args.shell,
        shell_args: args.shell_args,
        env: args.env,
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

#[tauri::command]
pub(crate) fn pty_pause(client: State<'_, Client>, session_id: String) -> Result<(), String> {
    match client.request(ClientOp::PauseSession { session_id })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
pub(crate) fn pty_resume(client: State<'_, Client>, session_id: String) -> Result<(), String> {
    match client.request(ClientOp::ResumeSession { session_id })? {
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
pub(crate) fn diff_decide(
    client: State<'_, Client>,
    diff_id: String,
    accepted: bool,
) -> Result<(), String> {
    match client.request(ClientOp::DiffDecision { diff_id, accepted })? {
        ServerOp::Ok => Ok(()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
    }
}

#[tauri::command]
pub(crate) fn search_history(
    client: State<'_, Client>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    match client.request(ClientOp::SearchHistory { query, limit })? {
        ServerOp::HistoryResults { matches } => Ok(matches.into_iter().map(Into::into).collect()),
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

/// Open a file path (optionally with line/column) in the configured editor.
/// Honours a caller-provided editor command first, then $EDITOR, then falls
/// back to `open` on macOS.
#[tauri::command]
pub(crate) fn open_in_editor(
    path: String,
    #[allow(non_snake_case)] line: Option<u32>,
    #[allow(non_snake_case)] column: Option<u32>,
    editor: Option<String>,
) -> Result<(), String> {
    use std::process::Command;

    // Build the target path with line:col suffix if we have one.
    let target = match (line, column) {
        (Some(l), Some(c)) => format!("{path}:{l}:{c}"),
        (Some(l), None) => format!("{path}:{l}"),
        _ => path.clone(),
    };

    if let Some(editor) = EditorCommand::from_configured(editor) {
        let mut cmd = editor.command();
        if editor.is_vscode_like() {
            cmd.arg("-g").arg(&target);
        } else {
            // Generic editor invocation. Some editors support +line; include
            // it only when we have a line.
            if let Some(l) = line {
                cmd.arg(format!("+{l}"));
            }
            cmd.arg(&path);
        }
        return spawn_detached(&mut cmd);
    }

    // No configured editor; fall back to macOS `open`, which routes to the
    // user's default editor association.
    let mut cmd = Command::new("open");
    cmd.arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    spawn_detached(&mut cmd)
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
