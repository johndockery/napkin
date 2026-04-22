//! Translation from daemon messages into Tauri window events.

use napkin_proto::ServerOp;
use tauri::{AppHandle, Emitter};

pub(crate) fn dispatch_event(app: &AppHandle, op: ServerOp) {
    match op {
        ServerOp::Output { session_id, data } => {
            let _ = app.emit(
                "pty-output",
                serde_json::json!({ "session_id": session_id, "data": data }),
            );
        }
        ServerOp::Exit { session_id } => {
            let _ = app.emit("pty-exit", serde_json::json!({ "session_id": session_id }));
        }
        ServerOp::Cwd { session_id, cwd } => {
            let _ = app.emit(
                "pane-cwd",
                serde_json::json!({ "session_id": session_id, "cwd": cwd }),
            );
        }
        ServerOp::Mark {
            session_id,
            mark,
            exit,
        } => {
            let _ = app.emit(
                "pane-mark",
                serde_json::json!({ "session_id": session_id, "mark": mark, "exit": exit }),
            );
        }
        ServerOp::DiffPrompt {
            session_id,
            diff_id,
            diff,
            title,
        } => {
            let _ = app.emit(
                "pane-diff-prompt",
                serde_json::json!({
                    "session_id": session_id,
                    "diff_id": diff_id,
                    "diff": diff,
                    "title": title
                }),
            );
        }
        ServerOp::Agent { session_id, agent } => {
            let _ = app.emit(
                "pane-agent",
                serde_json::json!({ "session_id": session_id, "agent": agent }),
            );
        }
        ServerOp::Status {
            session_id,
            state,
            agent,
            tokens,
            cost_usd,
        } => {
            let _ = app.emit(
                "pane-status",
                serde_json::json!({
                    "session_id": session_id,
                    "state": state,
                    "agent": agent,
                    "tokens": tokens,
                    "cost_usd": cost_usd
                }),
            );
        }
        _ => {}
    }
}
