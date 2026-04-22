//! `napkin` — companion CLI for the napkin terminal.

mod attach;
mod config;
mod workspace;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::process::ExitCode;

use napkin_proto::{socket_path, ClientMsg, ClientOp};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("hook") => hook_cmd(args),
        Some("diff") => diff_cmd(args),
        Some("workspace") | Some("ws") => workspace::run(args),
        Some("config") => config::run(args),
        Some("pause") => signal_cmd(args, Signal::Pause),
        Some("resume") => signal_cmd(args, Signal::Resume),
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
    eprintln!("{NAPKIN_BANNER}");
    eprintln!(
        "napkin — companion CLI\n\
         \n\
         Usage:\n\
           napkin list                            list daemon sessions\n\
           napkin attach <session_id>             attach to a session (Ctrl-\\ to detach)\n\
           napkin hook <state> [--agent NAME] [--tokens N] [--cost USD]\n\
           napkin diff [--file F | --stdin] [--title T]\n\
                                                 submit a unified diff for review;\n\
                                                 exits 0 on accept, 1 on reject\n\
           napkin workspace new <branch> [--base REF]\n\
                                                 create a git worktree at\n\
                                                 .napkin-worktrees/<branch>\n\
           napkin workspace list\n\
           napkin workspace rm <name>\n\
           napkin pause <session_id>              SIGSTOP the shell in a session\n\
           napkin resume <session_id>             SIGCONT the shell in a session\n\
           napkin config [path|edit|init|validate]\n\
                                                 inspect or edit ~/.config/napkin/config.toml\n\
           napkin --version                       print version\n\
         \n\
         State values recognised by the UI:\n\
           working   waiting   done   error   idle"
    );
}

fn diff_cmd(mut args: impl Iterator<Item = String>) -> ExitCode {
    use std::io::Read;

    let session_id = match std::env::var("NAPKIN_SESSION_ID") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            eprintln!("napkin: NAPKIN_SESSION_ID is not set; not running inside a napkin pane?");
            return ExitCode::from(1);
        }
    };

    let mut source: Option<DiffSource> = None;
    let mut title: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--file" => {
                let Some(path) = args.next() else {
                    eprintln!("napkin: --file requires a path");
                    return ExitCode::from(2);
                };
                source = Some(DiffSource::File(path));
            }
            "--stdin" => source = Some(DiffSource::Stdin),
            "--title" => title = args.next(),
            _ => {
                eprintln!("napkin: unexpected argument: {arg}");
                return ExitCode::from(2);
            }
        }
    }

    let diff_text = match source.unwrap_or(DiffSource::Stdin) {
        DiffSource::File(path) => match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("napkin: read {path}: {e}");
                return ExitCode::from(1);
            }
        },
        DiffSource::Stdin => {
            let mut buf = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
                eprintln!("napkin: read stdin: {e}");
                return ExitCode::from(1);
            }
            buf
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
    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkin: clone: {e}");
            return ExitCode::from(1);
        }
    };

    let diff_id = format!("diff-{}", std::process::id());
    let req_id: u64 = 1;
    let msg = napkin_proto::ClientMsg {
        id: Some(req_id),
        op: napkin_proto::ClientOp::DiffPreview {
            session_id,
            diff_id: diff_id.clone(),
            diff: diff_text,
            title,
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

    // Wait for the resolution keyed to our request id.
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(read_stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(reply) = serde_json::from_str::<napkin_proto::ServerMsg>(&line) else {
            continue;
        };
        if reply.id != Some(req_id) {
            continue;
        }
        if let napkin_proto::ServerOp::DiffResolved { accepted, .. } = reply.op {
            if accepted {
                println!("accepted");
                return ExitCode::SUCCESS;
            } else {
                println!("rejected");
                return ExitCode::from(1);
            }
        }
        if let napkin_proto::ServerOp::Err { error } = reply.op {
            eprintln!("napkin: {error}");
            return ExitCode::from(1);
        }
    }
    ExitCode::from(1)
}

enum DiffSource {
    File(String),
    Stdin,
}

enum Signal { Pause, Resume }

fn signal_cmd(mut args: impl Iterator<Item = String>, sig: Signal) -> ExitCode {
    let Some(session_id) = args.next() else {
        eprintln!("usage: napkin {} <session_id>",
            match sig { Signal::Pause => "pause", Signal::Resume => "resume" });
        return ExitCode::from(2);
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
    let msg = napkin_proto::ClientMsg {
        id: Some(1),
        op: match sig {
            Signal::Pause => napkin_proto::ClientOp::PauseSession { session_id },
            Signal::Resume => napkin_proto::ClientOp::ResumeSession { session_id },
        },
    };
    let line = match serde_json::to_string(&msg) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("napkin: encode: {e}");
            return ExitCode::from(1);
        }
    };
    if let Err(e) = writeln!(stream, "{line}") {
        eprintln!("napkin: write: {e}");
        return ExitCode::from(1);
    }

    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(reply) = serde_json::from_str::<napkin_proto::ServerMsg>(&line) else {
            continue;
        };
        if reply.id != Some(1) {
            continue;
        }
        return match reply.op {
            napkin_proto::ServerOp::Ok => ExitCode::SUCCESS,
            napkin_proto::ServerOp::Err { error } => {
                eprintln!("napkin: {error}");
                ExitCode::from(1)
            }
            _ => ExitCode::from(1),
        };
    }
    ExitCode::from(1)
}

const NAPKIN_BANNER: &str = r##"
                                              ....
                                            ........
                                           ...........
                                         ...............
                                       ...................
                                      ......................
                                    ..........................
                                  ..............................
                                 .................................
                               .....................................
                              ........................................
                             ...........................................
                           ...............................................
                         ..........................::-::.....................
                        ................-++++:..=********+-...................
                      ..............-+**+**++-+**+++**++***=.....................
                     ..............===+*++****+:.....=******.......................
                   ...................:******-........+*****:........................
                  .....................*****+:........=*****-..........................
                .....:.................*****+:........=*****=............................
               ....::..................+*****:........=*****+..............................
             ....::....................=*****-........-*****+...........................:=-
           ............................=***+*-........-******.........................:==
          .............................-*****=........-******........................-=--
         :::...........................-*****=........:******:.....................:==-:::-
          =--:.........................-*****+::.......=******++*:................-=-::-=--
           *+-:::...................:=+*********+.......=*****+-................:=-::-===*
             **--::.................:===-:.....................................=--::=-=#*
               *+--:::.......................................................-=-::===##
                 *+--::.........................................:..........:=-::-==*#
                   *+--::::...............................................-=-:-==*##
                     *+-::..............................................:=-:-==+##
                       *+-::...........................................=-::==+##
                         #+-::...........................:...........:=-:==+##
                          ##+-::::..................................=-:-==###
                            #*+-::................:...............-=--=+*##
                              ##+--:.............:..............:=--==*##
                                ##+--:........................:---==*##
                                  ##+--:::...................---==*##
                                    ##+--::::..............-=-==*##
                                      ##=--:.............:=-=++##
                                        #*=-::..........-==++##
                                          #*=-:.......:==++##
                                            #*=-:....===+##%
                                              **=-:-+++*##
                                                ##==*##%
                                                   ##
"##;

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
