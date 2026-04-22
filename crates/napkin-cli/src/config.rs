//! `napkin config` subcommand — print/edit/init/validate the user config.
//!
//! Deliberately does not depend on the Tauri side; the CLI resolves the
//! config path itself from $XDG_CONFIG_HOME / $HOME so it can be used when
//! the app isn't running.

use std::path::PathBuf;
use std::process::ExitCode;

const DEFAULT_TEMPLATE: &str = include_str!("../../../docs/config.default.toml");

pub(crate) fn run(mut args: impl Iterator<Item = String>) -> ExitCode {
    match args.next().as_deref() {
        Some("path") => path_cmd(),
        Some("edit") | None => edit_cmd(),
        Some("init") => init_cmd(),
        Some("validate") => validate_cmd(),
        Some(other) => {
            eprintln!("napkin config: unknown subcommand: {other}");
            usage();
            ExitCode::from(2)
        }
    }
}

fn usage() {
    eprintln!(
        "usage:\n\
         \x20\x20napkin config            open the config in $EDITOR\n\
         \x20\x20napkin config path       print the config file path\n\
         \x20\x20napkin config init       write the default template if missing\n\
         \x20\x20napkin config validate   parse the config and report errors"
    );
}

fn config_path() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("napkin").join("config.toml");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config/napkin/config.toml")
}

fn path_cmd() -> ExitCode {
    println!("{}", config_path().display());
    ExitCode::SUCCESS
}

fn ensure_file() -> Result<PathBuf, String> {
    let path = config_path();
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, DEFAULT_TEMPLATE).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn init_cmd() -> ExitCode {
    match ensure_file() {
        Ok(p) => {
            println!("wrote {}", p.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("napkin config: {e}");
            ExitCode::from(1)
        }
    }
}

fn edit_cmd() -> ExitCode {
    let path = match ensure_file() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("napkin config: {e}");
            return ExitCode::from(1);
        }
    };

    let editor = std::env::var("EDITOR").unwrap_or_default();
    let bin = editor
        .split_whitespace()
        .next()
        .map(|s| s.rsplit('/').next().unwrap_or(s).to_string())
        .unwrap_or_default();

    use std::process::Command;
    let status = if bin.is_empty() {
        Command::new("open").arg(&path).status()
    } else {
        Command::new(&bin).arg(&path).status()
    };

    match status {
        Ok(s) if s.success() => ExitCode::SUCCESS,
        Ok(s) => ExitCode::from(s.code().unwrap_or(1) as u8),
        Err(e) => {
            eprintln!("napkin config: {e}");
            ExitCode::from(1)
        }
    }
}

fn validate_cmd() -> ExitCode {
    let path = config_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                println!("no config at {} — using defaults", path.display());
                return ExitCode::SUCCESS;
            }
            eprintln!("napkin config: read {}: {e}", path.display());
            return ExitCode::from(1);
        }
    };
    match toml::from_str::<toml::Value>(&content) {
        Ok(_) => {
            println!("{} parses cleanly", path.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("napkin config: {}: {e}", path.display());
            ExitCode::from(1)
        }
    }
}
