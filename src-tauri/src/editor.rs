use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EditorCommand {
    pub program: String,
    pub args: Vec<String>,
    pub bin: String,
}

impl EditorCommand {
    pub fn from_configured(override_command: Option<String>) -> Option<Self> {
        let raw = override_command
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| std::env::var("EDITOR").unwrap_or_default());
        Self::parse(&raw)
    }

    fn parse(raw: &str) -> Option<Self> {
        let mut parts = split_command(raw);
        if parts.is_empty() {
            return None;
        }
        let program = parts.remove(0);
        let bin = Path::new(&program)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(program.as_str())
            .to_string();
        Some(Self {
            program,
            args: parts,
            bin,
        })
    }

    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd
    }

    pub fn is_vscode_like(&self) -> bool {
        matches!(
            self.bin.as_str(),
            "code" | "code-insiders" | "cursor" | "windsurf"
        )
    }
}

pub(crate) fn spawn_detached(cmd: &mut Command) -> Result<(), String> {
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn split_command(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in raw.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }

    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        parts.push(current);
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::EditorCommand;

    #[test]
    fn parses_plain_editor_command() {
        assert_eq!(
            EditorCommand::parse("code --reuse-window"),
            Some(EditorCommand {
                program: "code".to_string(),
                args: vec!["--reuse-window".to_string()],
                bin: "code".to_string(),
            }),
        );
    }

    #[test]
    fn parses_quoted_program_paths_and_args() {
        assert_eq!(
            EditorCommand::parse(
                "\"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code\" --wait"
            ),
            Some(EditorCommand {
                program: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
                    .to_string(),
                args: vec!["--wait".to_string()],
                bin: "code".to_string(),
            }),
        );
    }

    #[test]
    fn returns_none_for_empty_commands() {
        assert_eq!(EditorCommand::parse("   "), None);
    }
}
