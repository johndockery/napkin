//! Streaming OSC scanner. Feeds bytes from arbitrary chunks, emits events
//! when OSC sequences complete. Passes unknown OSCs through silently.

#[derive(Debug)]
pub enum OscEvent {
    Cwd(String),
    PromptStart,
    CommandStart,
    CommandEnd(Option<i32>),
}

pub struct OscScanner {
    buf: Vec<u8>,
    in_osc: bool,
    saw_esc: bool,
}

impl OscScanner {
    pub fn new() -> Self {
        Self { buf: Vec::new(), in_osc: false, saw_esc: false }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in data {
            if !self.in_osc {
                if self.saw_esc && b == b']' {
                    self.in_osc = true;
                    self.saw_esc = false;
                    self.buf.clear();
                } else if b == 0x1B {
                    self.saw_esc = true;
                } else {
                    self.saw_esc = false;
                }
            } else if b == 0x07 {
                if let Some(ev) = parse_osc(&self.buf) { events.push(ev); }
                self.buf.clear();
                self.in_osc = false;
                self.saw_esc = false;
            } else if self.saw_esc && b == b'\\' {
                if let Some(ev) = parse_osc(&self.buf) { events.push(ev); }
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
                "D" => Some(OscEvent::CommandEnd(parts.next().and_then(|s| s.parse().ok()))),
                _ => None,
            }
        }
        _ => None,
    }
}
