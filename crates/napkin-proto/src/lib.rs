//! Wire protocol between the napkin UI (Tauri client) and the napkind daemon.
//!
//! Framing: one JSON message per line (newline-delimited).
//! Direction is implicit from the socket role.

use serde::{Deserialize, Serialize};

/// Client → daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientMsg {
    /// Correlation id. Required for requests that expect a reply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(flatten)]
    pub op: ClientOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientOp {
    Ping,
    Spawn {
        rows: u16,
        cols: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shell: Option<String>,
    },
    Write {
        session_id: String,
        data: Vec<u8>,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        session_id: String,
    },
    List,
    /// Attach the connected client to an existing session's event stream.
    /// Replies Ok on success or Err if the session no longer exists.
    Subscribe {
        session_id: String,
    },
    /// Explicit semantic state update, typically from an in-shell agent hook
    /// (e.g., Claude Code's Stop hook). Overrides whatever the daemon would
    /// otherwise infer from OSC 133 marks, until the next explicit update.
    AgentState {
        session_id: String,
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    /// Full-text search across the daemon's persisted command history.
    /// The match is substring against the command text for now.
    SearchHistory {
        query: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<u32>,
    },
}

/// Daemon → client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerMsg {
    /// When present, this is a reply to a request with the same id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(flatten)]
    pub op: ServerOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ServerOp {
    Pong,
    Ok,
    Err {
        error: String,
    },
    SpawnOk {
        session_id: String,
    },
    ListOk {
        sessions: Vec<SessionInfo>,
    },

    // Async events (no id)
    Output {
        session_id: String,
        data: Vec<u8>,
    },
    Exit {
        session_id: String,
    },
    Cwd {
        session_id: String,
        cwd: String,
    },
    Mark {
        session_id: String,
        mark: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit: Option<i32>,
    },
    /// The foreground command on a session has been classified as a known
    /// agent, or cleared (when `agent` is `None`).
    Agent {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    /// Semantic state update broadcast from an explicit agent hook or from
    /// internal state transitions.
    Status {
        session_id: String,
        state: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    /// Reply to SearchHistory: every command matching the query, newest first.
    HistoryResults {
        matches: Vec<HistoryMatch>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryMatch {
    pub session_id: String,
    pub cwd: String,
    pub cmd: String,
    pub started_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
}

/// Path to the user's napkind socket.
pub fn socket_path() -> std::path::PathBuf {
    let tmp = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
    let user = std::env::var("USER").unwrap_or_else(|_| "unknown".into());
    std::path::PathBuf::from(tmp).join(format!("napkind-{}.sock", user))
}
