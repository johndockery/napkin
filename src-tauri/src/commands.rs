//! Tauri command handlers. These preserve the existing invoke surface exactly.

use napkin_proto::{ClientOp, ServerOp, SessionInfo};
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

#[tauri::command]
pub(crate) fn pty_list(client: State<'_, Client>) -> Result<Vec<PtySession>, String> {
    match client.request(ClientOp::List)? {
        ServerOp::ListOk { sessions } => Ok(sessions.into_iter().map(Into::into).collect()),
        ServerOp::Err { error } => Err(error),
        other => Err(format!("unexpected reply: {other:?}")),
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
    match client.request(ClientOp::Subscribe {
        session_id: session_id.clone(),
    })? {
        ServerOp::Ok => {}
        ServerOp::Err { error } => return Err(error),
        other => return Err(format!("unexpected reply: {other:?}")),
    }
    // Send an immediate resize so the existing PTY matches the fresh window.
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
