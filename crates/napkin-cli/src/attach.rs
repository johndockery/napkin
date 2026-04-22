//! `napkin attach <session>` — remote control a napkind session from any
//! terminal. Puts stdin in raw mode, relays bytes to/from the daemon.
//!
//! Detach with Ctrl-\ (normally SIGQUIT; in attach mode we intercept it and
//! disconnect cleanly).

use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use napkin_proto::{socket_path, ClientMsg, ClientOp, ServerMsg, ServerOp, SessionInfo};

/// Ctrl-\ = FS. In raw mode we capture it and detach.
const DETACH_KEY: u8 = 0x1C;

pub(crate) fn list() -> ExitCode {
    let socket = socket_path();
    let stream = match UnixStream::connect(&socket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkin: connect {} failed: {e}", socket.display());
            return ExitCode::from(1);
        }
    };
    let write_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkin: clone: {e}");
            return ExitCode::from(1);
        }
    };

    let req = ClientMsg {
        id: Some(1),
        op: ClientOp::List,
    };
    let line = match serde_json::to_string(&req) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("napkin: encode: {e}");
            return ExitCode::from(1);
        }
    };
    let mut ws = write_stream;
    if let Err(e) = writeln!(ws, "{line}") {
        eprintln!("napkin: write: {e}");
        return ExitCode::from(1);
    }

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<ServerMsg>(&line) else {
            continue;
        };
        if msg.id != Some(1) {
            continue;
        }
        match msg.op {
            ServerOp::ListOk { sessions } => {
                print_sessions(&sessions);
                return ExitCode::SUCCESS;
            }
            ServerOp::Err { error } => {
                eprintln!("napkin: {error}");
                return ExitCode::from(1);
            }
            _ => {}
        }
    }
    ExitCode::from(1)
}

fn print_sessions(sessions: &[SessionInfo]) {
    if sessions.is_empty() {
        println!("(no sessions)");
        return;
    }
    for s in sessions {
        println!("{}\t{}", s.session_id, s.cwd);
    }
}

pub(crate) fn attach(session_id: String) -> ExitCode {
    let stdin_fd = std::io::stdin().as_raw_fd();

    if unsafe { libc::isatty(stdin_fd) } == 0 {
        eprintln!("napkin: attach requires a tty on stdin");
        return ExitCode::from(1);
    }

    let socket = socket_path();
    let stream = match UnixStream::connect(&socket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkin: connect {} failed: {e}", socket.display());
            return ExitCode::from(1);
        }
    };
    let write_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("napkin: clone: {e}");
            return ExitCode::from(1);
        }
    };
    let writer = Arc::new(Mutex::new(write_stream));

    // Subscribe first; daemon replies Ok and starts streaming.
    if let Err(e) = send_msg(
        &writer,
        &ClientMsg {
            id: Some(1),
            op: ClientOp::Subscribe {
                session_id: session_id.clone(),
            },
        },
    ) {
        eprintln!("napkin: subscribe: {e}");
        return ExitCode::from(1);
    }

    // Install raw mode; RAII guard restores on drop.
    let raw_guard = match RawModeGuard::enable(stdin_fd) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("napkin: raw mode failed: {e}");
            return ExitCode::from(1);
        }
    };

    // Initial size + a polling thread that detects resizes while attached.
    let initial = winsize(stdin_fd);
    let _ = send_msg(
        &writer,
        &ClientMsg {
            id: None,
            op: ClientOp::Resize {
                session_id: session_id.clone(),
                rows: initial.0,
                cols: initial.1,
            },
        },
    );

    let should_exit = Arc::new(AtomicBool::new(false));

    // Resize watcher
    let resize_sid = session_id.clone();
    let resize_writer = writer.clone();
    let resize_exit = should_exit.clone();
    thread::spawn(move || {
        let mut last = initial;
        while !resize_exit.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(250));
            let cur = winsize(stdin_fd);
            if cur != last && cur.0 > 0 && cur.1 > 0 {
                last = cur;
                let _ = send_msg(
                    &resize_writer,
                    &ClientMsg {
                        id: None,
                        op: ClientOp::Resize {
                            session_id: resize_sid.clone(),
                            rows: cur.0,
                            cols: cur.1,
                        },
                    },
                );
            }
        }
    });

    // Stdin → Write
    let stdin_sid = session_id.clone();
    let stdin_writer = writer.clone();
    let stdin_exit = should_exit.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 2048];
        let stdin = std::io::stdin();
        let mut lock = stdin.lock();
        loop {
            if stdin_exit.load(Ordering::Relaxed) {
                break;
            }
            match lock.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Intercept detach key; forward everything else verbatim.
                    if let Some(pos) = buf[..n].iter().position(|&b| b == DETACH_KEY) {
                        if pos > 0 {
                            let _ = send_msg(
                                &stdin_writer,
                                &ClientMsg {
                                    id: None,
                                    op: ClientOp::Write {
                                        session_id: stdin_sid.clone(),
                                        data: buf[..pos].to_vec(),
                                    },
                                },
                            );
                        }
                        stdin_exit.store(true, Ordering::Relaxed);
                        break;
                    }
                    if let Err(_) = send_msg(
                        &stdin_writer,
                        &ClientMsg {
                            id: None,
                            op: ClientOp::Write {
                                session_id: stdin_sid.clone(),
                                data: buf[..n].to_vec(),
                            },
                        },
                    ) {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Main loop: socket → stdout
    let reader = BufReader::new(stream);
    let stdout = std::io::stdout();
    for line in reader.lines() {
        if should_exit.load(Ordering::Relaxed) {
            break;
        }
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<ServerMsg>(&line) else {
            continue;
        };
        match msg.op {
            ServerOp::Output { data, .. } => {
                let mut out = stdout.lock();
                if out.write_all(&data).is_err() {
                    break;
                }
                let _ = out.flush();
            }
            ServerOp::Exit { .. } => {
                should_exit.store(true, Ordering::Relaxed);
                break;
            }
            ServerOp::Err { error } => {
                let mut out = stdout.lock();
                let _ = writeln!(out, "\r\nnapkin: {error}\r");
                should_exit.store(true, Ordering::Relaxed);
                break;
            }
            _ => {}
        }
    }

    should_exit.store(true, Ordering::Relaxed);
    drop(raw_guard);
    println!("\r\n[detached]");
    ExitCode::SUCCESS
}

fn send_msg(
    writer: &Arc<Mutex<UnixStream>>,
    msg: &ClientMsg,
) -> std::io::Result<()> {
    let line = serde_json::to_string(msg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let mut w = writer.lock().unwrap();
    writeln!(w, "{line}")
}

fn winsize(fd: RawFd) -> (u16, u16) {
    #[repr(C)]
    struct Winsize {
        ws_row: u16,
        ws_col: u16,
        ws_xpixel: u16,
        ws_ypixel: u16,
    }
    let mut ws: Winsize = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
    if rc != 0 {
        return (24, 80);
    }
    (ws.ws_row, ws.ws_col)
}

struct RawModeGuard {
    fd: RawFd,
    original: libc::termios,
}

impl RawModeGuard {
    fn enable(fd: RawFd) -> std::io::Result<Self> {
        let mut original: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut raw = original;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &raw) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { fd, original })
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        unsafe {
            libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
    }
}
