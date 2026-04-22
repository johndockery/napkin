//! Writes the napkin zsh integration shim to disk.

use std::path::PathBuf;

const ZSH_ZSHENV: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zshenv" ]] && . "$HOME/.zshenv"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir
"#;

const ZSH_ZPROFILE: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zprofile" ]] && . "$HOME/.zprofile"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir
"#;

const ZSH_ZSHRC: &str = r#"# napkin shell integration
__napkin_zdotdir="$ZDOTDIR"
export ZDOTDIR="$HOME"
[[ -f "$HOME/.zshrc" ]] && . "$HOME/.zshrc"
export ZDOTDIR="$__napkin_zdotdir"
unset __napkin_zdotdir

autoload -Uz add-zsh-hook 2>/dev/null

__napkin_preexec() {
  # OSC 8274 ; cmd ; <command line> ST — private napkin sequence carrying the
  # shell command being executed, used for agent detection on the daemon side.
  # Emitted just before the standard OSC 133 ; C mark so consumers that only
  # know about 133 keep working.
  printf '\e]8274;cmd;%s\a\e]133;C;\a' "${1//$'\r'/}"
}
__napkin_precmd() {
  local ec=$?
  printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' \
    "$ec" "${HOST:-${HOSTNAME:-localhost}}" "$PWD"
}
add-zsh-hook preexec __napkin_preexec 2>/dev/null
add-zsh-hook precmd  __napkin_precmd  2>/dev/null

printf '\e]133;A\a\e]7;file://%s%s\a' \
  "${HOST:-${HOSTNAME:-localhost}}" "$PWD"

unset ZDOTDIR
"#;

pub fn ensure_zsh_shim() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join(".local/share/napkin/zsh");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zshenv"), ZSH_ZSHENV).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zprofile"), ZSH_ZPROFILE).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(".zshrc"), ZSH_ZSHRC).map_err(|e| e.to_string())?;
    Ok(dir)
}

const BASH_RCFILE: &str = r#"# napkin shell integration for bash
# Sources the user's ~/.bashrc and installs OSC 133 + OSC 7 hooks.

[[ -f "$HOME/.bashrc" ]] && . "$HOME/.bashrc"

__napkin_prompt_command() {
    local exit=$?
    printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' \
        "$exit" "${HOSTNAME:-localhost}" "$PWD"
}

__napkin_preexec() {
    # Only emit on top-level commands; skip subshell noise and our own hooks.
    [[ $BASH_SUBSHELL -gt 0 ]] && return
    case "$BASH_COMMAND" in
        __napkin_*) return ;;
    esac
    printf '\e]8274;cmd;%s\a\e]133;C;\a' "$BASH_COMMAND"
}

if [[ -n "$PROMPT_COMMAND" && "$PROMPT_COMMAND" != *__napkin_prompt_command* ]]; then
    PROMPT_COMMAND="__napkin_prompt_command;${PROMPT_COMMAND}"
else
    PROMPT_COMMAND="__napkin_prompt_command"
fi

trap '__napkin_preexec' DEBUG

# First prompt
printf '\e]133;A\a\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD"
"#;

pub fn ensure_bash_shim() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&home).join(".local/share/napkin/bash");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let rcfile = dir.join("bashrc");
    std::fs::write(&rcfile, BASH_RCFILE).map_err(|e| e.to_string())?;
    Ok(rcfile)
}

const FISH_INIT: &str = r#"# napkin shell integration for fish
# Loaded from conf.d at fish startup alongside any user config.

function __napkin_prompt --on-event fish_prompt
    set -l exit $status
    printf '\e]133;D;%d\a\e]133;A\a\e]7;file://%s%s\a' \
        $exit (hostname) (pwd)
end

function __napkin_preexec --on-event fish_preexec
    printf '\e]8274;cmd;%s\a\e]133;C;\a' "$argv"
end

# First prompt
printf '\e]133;A\a\e]7;file://%s%s\a' (hostname) (pwd)
"#;

pub fn ensure_fish_shim() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    // fish's XDG-style config root; conf.d files are auto-loaded.
    let dir = PathBuf::from(&home).join(".local/share/napkin/fish/conf.d");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("napkin.fish");
    std::fs::write(&file, FISH_INIT).map_err(|e| e.to_string())?;
    Ok(file)
}

/// Parent of our fish conf.d — what XDG_CONFIG_HOME/fish would normally be.
pub fn fish_config_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(PathBuf::from(&home).join(".local/share/napkin/fish"))
}
