//! `napkin workspace` — git-worktree plumbing so multiple agents can work
//! on the same repo without stepping on each other.
//!
//!   napkin workspace new <branch> [--base <ref>] [--root <dir>]
//!   napkin workspace list
//!   napkin workspace rm <name>
//!
//! Worktrees live under `<repo-root>/.napkin-worktrees/<sanitized-name>`
//! by default, so `git worktree list` sees them and nothing gets orphaned
//! in a random home directory.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

pub(crate) fn run(mut args: impl Iterator<Item = String>) -> ExitCode {
    match args.next().as_deref() {
        Some("new") => new(args),
        Some("list") => list(),
        Some("rm") => rm(args),
        Some(other) => {
            eprintln!("napkin workspace: unknown subcommand: {other}");
            usage();
            ExitCode::from(2)
        }
        None => {
            usage();
            ExitCode::from(2)
        }
    }
}

fn usage() {
    eprintln!(
        "usage:\n\
         \x20\x20napkin workspace new <branch> [--base <ref>] [--root <dir>]\n\
         \x20\x20napkin workspace list\n\
         \x20\x20napkin workspace rm <name>"
    );
}

fn new(mut args: impl Iterator<Item = String>) -> ExitCode {
    let Some(branch) = args.next() else {
        usage();
        return ExitCode::from(2);
    };
    let mut base: Option<String> = None;
    let mut root: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--base" => base = args.next(),
            "--root" => root = args.next().map(PathBuf::from),
            _ => {
                eprintln!("napkin workspace: unexpected argument: {arg}");
                return ExitCode::from(2);
            }
        }
    }

    let repo_root = match root {
        Some(r) => r,
        None => match git_toplevel(&std::env::current_dir().unwrap_or_default()) {
            Some(p) => p,
            None => {
                eprintln!("napkin workspace: not inside a git repository (pass --root)");
                return ExitCode::from(1);
            }
        },
    };

    let worktrees = repo_root.join(".napkin-worktrees");
    if let Err(e) = std::fs::create_dir_all(&worktrees) {
        eprintln!("napkin workspace: create {}: {e}", worktrees.display());
        return ExitCode::from(1);
    }

    let sanitized = sanitize(&branch);
    let path = worktrees.join(&sanitized);
    if path.exists() {
        eprintln!(
            "napkin workspace: {} already exists",
            path.display()
        );
        return ExitCode::from(1);
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(&repo_root);
    cmd.arg("worktree").arg("add").arg("-b").arg(&branch).arg(&path);
    if let Some(base) = base {
        cmd.arg(&base);
    }
    let status = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("{}", path.display());
            ExitCode::SUCCESS
        }
        Ok(s) => {
            eprintln!("napkin workspace: git worktree add exited with {s}");
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("napkin workspace: spawn git: {e}");
            ExitCode::from(1)
        }
    }
}

fn list() -> ExitCode {
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(repo_root) = git_toplevel(&cwd) else {
        eprintln!("napkin workspace: not inside a git repository");
        return ExitCode::from(1);
    };
    let status = Command::new("git")
        .current_dir(&repo_root)
        .arg("worktree")
        .arg("list")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        _ => ExitCode::from(1),
    }
}

fn rm(mut args: impl Iterator<Item = String>) -> ExitCode {
    let Some(name) = args.next() else {
        usage();
        return ExitCode::from(2);
    };
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(repo_root) = git_toplevel(&cwd) else {
        eprintln!("napkin workspace: not inside a git repository");
        return ExitCode::from(1);
    };
    let path = repo_root.join(".napkin-worktrees").join(sanitize(&name));
    let status = Command::new("git")
        .current_dir(&repo_root)
        .arg("worktree")
        .arg("remove")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status();
    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        _ => ExitCode::from(1),
    }
}

fn git_toplevel(from: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .current_dir(from)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let trimmed = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn sanitize(input: &str) -> String {
    input
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}
