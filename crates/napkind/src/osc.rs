//! Streaming OSC scanner. Feeds bytes from arbitrary chunks, emits events
//! when OSC sequences complete. Passes unknown OSCs through silently.

#[derive(Debug, PartialEq, Eq)]
pub enum OscEvent {
    Cwd(String),
    PromptStart,
    CommandStart,
    CommandEnd(Option<i32>),
    /// Private napkin OSC 8274 ; cmd ; <command line>.
    /// Emitted by the zsh shim just before OSC 133 ; C.
    CommandLine(String),
}

pub struct OscScanner {
    buf: Vec<u8>,
    in_osc: bool,
    saw_esc: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            in_osc: false,
            saw_esc: false,
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in data {
            if !self.in_osc {
                if self.saw_esc && b == b']' {
                    self.in_osc = true;
                    self.saw_esc = false;
                    self.buf.clear();
                } else {
                    self.saw_esc = b == 0x1B;
                }
            } else if b == 0x07 || (self.saw_esc && b == b'\\') {
                if let Some(ev) = parse_osc(&self.buf) {
                    events.push(ev);
                }
                self.buf.clear();
                self.in_osc = false;
                self.saw_esc = false;
            } else if b == 0x1B {
                self.saw_esc = true;
            } else {
                self.saw_esc = false;
                if self.buf.len() < 4096 {
                    self.buf.push(b);
                }
            }
        }
        events
    }
}

fn parse_osc(payload: &[u8]) -> Option<OscEvent> {
    let s = std::str::from_utf8(payload).ok()?;
    let (ident, rest) = s.split_once(';').unwrap_or((s, ""));
    match ident {
        "7" => {
            let path = rest.strip_prefix("file://").unwrap_or(rest);
            let path = path.find('/').map(|i| &path[i..]).unwrap_or(path);
            Some(OscEvent::Cwd(path.to_string()))
        }
        "133" => {
            let mut parts = rest.split(';');
            match parts.next()? {
                "A" | "B" => Some(OscEvent::PromptStart),
                "C" => Some(OscEvent::CommandStart),
                "D" => Some(OscEvent::CommandEnd(
                    parts.next().and_then(|s| s.parse().ok()),
                )),
                _ => None,
            }
        }
        "8274" => {
            // Private napkin OSC. Currently one subtype: `cmd;<command line>`.
            let (tag, body) = rest.split_once(';').unwrap_or((rest, ""));
            match tag {
                "cmd" => Some(OscEvent::CommandLine(body.to_string())),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{OscEvent, OscScanner};

    #[test]
    fn parses_bel_terminated_prompt_and_command_marks() {
        let mut scanner = OscScanner::new();

        assert_eq!(
            scanner.feed(b"\x1b]133;A\x07\x1b]133;C;\x07\x1b]133;D;2\x07"),
            vec![
                OscEvent::PromptStart,
                OscEvent::CommandStart,
                OscEvent::CommandEnd(Some(2)),
            ],
        );
    }

    #[test]
    fn parses_st_terminated_command_line_across_chunks() {
        let mut scanner = OscScanner::new();

        assert!(scanner.feed(b"\x1b]8274;cmd;/usr/bin/cla").is_empty());
        assert_eq!(
            scanner.feed(b"ude --dangerously-skip-permissions\x1b\\"),
            vec![OscEvent::CommandLine(
                "/usr/bin/claude --dangerously-skip-permissions".to_string(),
            )],
        );
    }

    #[test]
    fn parses_osc_7_cwd_with_host_prefix() {
        let mut scanner = OscScanner::new();

        assert_eq!(
            scanner.feed(b"\x1b]7;file://workstation.local/Users/john/code/napkin\x07"),
            vec![OscEvent::Cwd("/Users/john/code/napkin".to_string())],
        );
    }

    #[test]
    fn ignores_unknown_and_incomplete_sequences() {
        let mut scanner = OscScanner::new();

        assert!(scanner.feed(b"\x1b]999;ignored\x07").is_empty());
        assert!(scanner.feed(b"\x1b]133;").is_empty());
    }
}
