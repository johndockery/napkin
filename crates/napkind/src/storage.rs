//! On-disk persistence for napkind. SQLite lives at
//! `~/.local/share/napkin/napkind.sqlite3` and holds:
//!
//!   sessions            - id, cwd, created_at, last_seen
//!   commands            - session_id, seq, cmd, cwd, started_at, ended_at,
//!                         exit_code (powers cross-session history search)
//!   scrollback_chunks   - session_id, offset, data BLOB, created_at
//!                         (append-only; lets reattach survive reboots)
//!   tab_metadata        - session_id, name, color (preserves user tweaks)
//!
//! If the DB can't be opened, `Storage::disconnected()` returns an instance
//! whose methods are all silent no-ops, so persistence failure degrades
//! cleanly to the in-memory path we had before.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};

pub(crate) struct Storage {
    conn: Mutex<Option<Connection>>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // created_at_ms / last_seen_ms will be surfaced in UI soon.
pub(crate) struct StoredSession {
    pub id: String,
    pub cwd: String,
    pub created_at_ms: i64,
    pub last_seen_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct StoredCommand {
    pub session_id: String,
    pub cwd: String,
    pub cmd: String,
    pub started_at_ms: i64,
    pub ended_at_ms: Option<i64>,
    pub exit_code: Option<i32>,
}

impl Storage {
    pub fn open() -> Result<Self, String> {
        let dir = data_dir()?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("napkind.sqlite3");
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;

        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                cwd         TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                last_seen   INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS commands (
                session_id  TEXT NOT NULL,
                seq         INTEGER NOT NULL,
                cmd         TEXT NOT NULL,
                cwd         TEXT NOT NULL,
                started_at  INTEGER NOT NULL,
                ended_at    INTEGER,
                exit_code   INTEGER,
                PRIMARY KEY(session_id, seq)
            );

            CREATE INDEX IF NOT EXISTS commands_started_idx
                ON commands(started_at DESC);

            CREATE TABLE IF NOT EXISTS scrollback_chunks (
                session_id  TEXT NOT NULL,
                offset      INTEGER NOT NULL,
                data        BLOB NOT NULL,
                created_at  INTEGER NOT NULL,
                PRIMARY KEY(session_id, offset)
            );

            CREATE TABLE IF NOT EXISTS tab_metadata (
                session_id  TEXT PRIMARY KEY,
                name        TEXT,
                color       TEXT
            );
            "#,
        )
        .map_err(|e| e.to_string())?;

        Ok(Self {
            conn: Mutex::new(Some(conn)),
        })
    }

    pub fn disconnected() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }

    fn with_conn<F: FnOnce(&Connection)>(&self, f: F) {
        let Ok(guard) = self.conn.lock() else { return };
        if let Some(conn) = guard.as_ref() {
            f(conn);
        }
    }

    pub fn record_session(&self, session_id: &str, cwd: &str) {
        let now = now_ms();
        self.with_conn(|c| {
            let _ = c.execute(
                "INSERT INTO sessions(id, cwd, created_at, last_seen)
                 VALUES (?1, ?2, ?3, ?3)
                 ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, last_seen = excluded.last_seen",
                params![session_id, cwd, now],
            );
        });
    }

    pub fn touch_session(&self, session_id: &str) {
        self.with_conn(|c| {
            let _ = c.execute(
                "UPDATE sessions SET last_seen = ?1 WHERE id = ?2",
                params![now_ms(), session_id],
            );
        });
    }

    pub fn append_scrollback(&self, session_id: &str, offset: usize, data: &[u8]) {
        self.with_conn(|c| {
            let _ = c.execute(
                "INSERT OR REPLACE INTO scrollback_chunks
                    (session_id, offset, data, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![session_id, offset as i64, data, now_ms()],
            );
        });
    }

    pub fn record_command(&self, rec: &StoredCommand, seq: i64) {
        self.with_conn(|c| {
            let _ = c.execute(
                "INSERT OR REPLACE INTO commands
                    (session_id, seq, cmd, cwd, started_at, ended_at, exit_code)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    rec.session_id,
                    seq,
                    rec.cmd,
                    rec.cwd,
                    rec.started_at_ms,
                    rec.ended_at_ms,
                    rec.exit_code,
                ],
            );
        });
    }

    /// Forget a session's resurrectable state while retaining command
    /// history, so closing a pane does not resurrect it on the next boot.
    pub fn forget_session(&self, session_id: &str) {
        self.with_conn(|c| {
            let _ = c.execute(
                "DELETE FROM scrollback_chunks WHERE session_id = ?1",
                params![session_id],
            );
            let _ = c.execute(
                "DELETE FROM tab_metadata WHERE session_id = ?1",
                params![session_id],
            );
            let _ = c.execute("DELETE FROM sessions WHERE id = ?1", params![session_id]);
        });
    }

    /// Load recent sessions from disk for startup rehydration. Sessions
    /// whose last_seen is older than `max_age_ms` are skipped so the user
    /// isn't greeted with a wall of stale tabs from last month.
    pub fn load_recent_sessions(&self, max_age_ms: i64) -> Vec<StoredSession> {
        let Ok(guard) = self.conn.lock() else {
            return Vec::new();
        };
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        let cutoff = now_ms() - max_age_ms;
        let mut stmt = match conn.prepare(
            "SELECT id, cwd, created_at, last_seen FROM sessions
             WHERE last_seen >= ?1 ORDER BY last_seen DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![cutoff], |row| {
            Ok(StoredSession {
                id: row.get(0)?,
                cwd: row.get(1)?,
                created_at_ms: row.get(2)?,
                last_seen_ms: row.get(3)?,
            })
        });
        match rows {
            Ok(mapped) => mapped.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Concatenated scrollback chunks for a session, in order. Reassembles
    /// whatever survived in SQLite so reattach after a daemon restart still
    /// shows history.
    pub fn load_scrollback(&self, session_id: &str, max_bytes: usize) -> Vec<u8> {
        let Ok(guard) = self.conn.lock() else {
            return Vec::new();
        };
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        let mut stmt = match conn.prepare(
            "SELECT data FROM scrollback_chunks
             WHERE session_id = ?1 ORDER BY offset ASC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![session_id], |row| row.get::<_, Vec<u8>>(0));
        let mut out: Vec<u8> = Vec::new();
        if let Ok(iter) = rows {
            for chunk in iter.flatten() {
                out.extend_from_slice(&chunk);
            }
        }
        if out.len() > max_bytes {
            let drop = out.len() - max_bytes;
            out.drain(0..drop);
        }
        out
    }

    pub fn search_commands(&self, query: &str, limit: u32) -> Vec<StoredCommand> {
        let Ok(guard) = self.conn.lock() else {
            return Vec::new();
        };
        let Some(conn) = guard.as_ref() else {
            return Vec::new();
        };
        let like = format!("%{query}%");
        let mut stmt = match conn.prepare(
            "SELECT session_id, cwd, cmd, started_at, ended_at, exit_code
             FROM commands
             WHERE cmd LIKE ?1
             ORDER BY started_at DESC
             LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt.query_map(params![like, limit as i64], |row| {
            Ok(StoredCommand {
                session_id: row.get(0)?,
                cwd: row.get(1)?,
                cmd: row.get(2)?,
                started_at_ms: row.get(3)?,
                ended_at_ms: row.get(4)?,
                exit_code: row.get(5)?,
            })
        });
        match rows {
            Ok(mapped) => mapped.flatten().collect(),
            Err(_) => Vec::new(),
        }
    }
}

fn data_dir() -> Result<PathBuf, String> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return Ok(PathBuf::from(xdg).join("napkin"));
        }
    }
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(home).join(".local/share/napkin"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
