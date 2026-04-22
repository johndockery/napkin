//! Tauri command handlers. These preserve the existing invoke surface exactly.

use napkin_proto::{ClientOp, ServerOp};
use serde::Deserialize;
use tauri::State;

use crate::client::Client;

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
