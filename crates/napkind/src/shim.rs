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

__napkin_preexec() { printf '\e]133;C;\a' }
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
