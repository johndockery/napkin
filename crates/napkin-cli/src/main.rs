//! `napkin` — the companion CLI for the napkin terminal.
//!
//! For now, the only subcommand is `hook`, which reports a semantic state
//! transition for the pane the CLI is running in. The pane is identified by
//! the NAPKIN_SESSION_ID env var that napkind exports when spawning a shell.
//!
//! Intended wiring, e.g. Claude Code's settings.json:
//!
//!   { "hooks": { "Stop": "napkin hook waiting" } }
//!
//! This lets the terminal know exactly when the agent is waiting for you,
//! instead of guessing from output.

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use napkin_proto::{socket_path, ClientMsg, ClientOp};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("hook") => {
            let state = match args.next() {
                Some(s) => s,
                None => {
                    eprintln!("usage: napkin hook <state> [--agent <name>]");
                    return ExitCode::from(2);
                }
            };
            let mut agent: Option<String> = None;
            while let Some(arg) = args.next() {
                if arg == "--agent" {
                    agent = args.next();
                } else {
                    eprintln!("napkin: unexpected argument: {arg}");
                    return ExitCode::from(2);
                }
            }
            run_hook(state, agent)
        }
        Some("--version") | Some("-V") => {
            println!("napkin {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Some("--help") | Some("-h") | None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("napkin: unknown subcommand: {other}");
            print_usage();
            ExitCode::from(2)
        }
    }
}

fn print_usage() {
    eprintln!(
        "napkin — companion CLI\n\
         \n\
         Usage:\n\
           napkin hook <state> [--agent <name>]   report a semantic state change\n\
           napkin --version                       print version\n\
         \n\
         States are free-form strings; the UI recognises:\n\
           working   waiting   done   error   idle"
    );
}

fn run_hook(state: String, agent: Option<String>) -> ExitCode {
    let session_id = match std::env::var("NAPKIN_SESSION_ID") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            eprintln!("napkin: NAPKIN_SESSION_ID is not set; not running inside a napkin pane?");
            return ExitCode::from(1);
        }
    };

    let socket = std::env::var("NAPKIN_SOCKET")
        .ok()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(socket_path);

    let mut stream = match UnixStream::connect(&socket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "napkin: connect {} failed: {e}",
                socket.display()
            );
            return ExitCode::from(1);
        }
    };

    let msg = ClientMsg {
        id: None,
        op: ClientOp::AgentState {
            session_id,
            state,
            agent,
        },
    };
    let line = match serde_json::to_string(&msg) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("napkin: encode failed: {e}");
            return ExitCode::from(1);
        }
    };
    if let Err(e) = writeln!(stream, "{line}") {
        eprintln!("napkin: write failed: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
