//! `napkin` — companion CLI for the napkin terminal.

mod attach;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use napkin_proto::{socket_path, ClientMsg, ClientOp};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("hook") => hook_cmd(args),
        Some("list") | Some("ls") => attach::list(),
        Some("attach") => {
            let Some(session_id) = args.next() else {
                eprintln!("usage: napkin attach <session_id>");
                return ExitCode::from(2);
            };
            attach::attach(session_id)
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
           napkin list                            list daemon sessions\n\
           napkin attach <session_id>             attach to a session (Ctrl-\\ to detach)\n\
           napkin hook <state> [--agent <name>]   report a semantic state change\n\
           napkin --version                       print version\n\
         \n\
         State values recognised by the UI:\n\
           working   waiting   done   error   idle"
    );
}

fn hook_cmd(mut args: impl Iterator<Item = String>) -> ExitCode {
    let state = match args.next() {
        Some(s) => s,
        None => {
            eprintln!(
                "usage: napkin hook <state> [--agent <name>] [--tokens <n>] [--cost <usd>]"
            );
            return ExitCode::from(2);
        }
    };
    let mut agent: Option<String> = None;
    let mut tokens: Option<u64> = None;
    let mut cost_usd: Option<f64> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--agent" => agent = args.next(),
            "--tokens" => {
                tokens = args.next().and_then(|v| v.parse().ok());
            }
            "--cost" => {
                cost_usd = args.next().and_then(|v| v.parse().ok());
            }
            _ => {
                eprintln!("napkin: unexpected argument: {arg}");
                return ExitCode::from(2);
            }
        }
    }

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
            eprintln!("napkin: connect {} failed: {e}", socket.display());
            return ExitCode::from(1);
        }
    };

    let msg = ClientMsg {
        id: None,
        op: ClientOp::AgentState {
            session_id,
            state,
            agent,
            tokens,
            cost_usd,
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
