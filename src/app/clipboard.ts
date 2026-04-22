//! OSC 52 clipboard integration. Registers an xterm OSC handler for the
//! "set clipboard" sequence so programs running inside napkin (and inside
//! ssh sessions nested within napkin) can copy to the host clipboard.
//!
//! Reads (OSC 52;c;?) are deliberately not supported — it's a classic
//! data-exfil vector and nobody needs it.

import type { Terminal } from "@xterm/xterm";

const CLIPBOARD_TARGETS = new Set(["c", "p", "q", "s", "0", "1", "2", "3", "4", "5", "6", "7"]);

export function registerClipboardHandler(terminal: Terminal): void {
  // xterm's registerOscHandler returns an IDisposable. We intentionally
  // leak it — the terminal is disposed by panes.ts when the leaf goes
  // away, which takes the handler with it.
  terminal.parser.registerOscHandler(52, (data) => {
    const [target, payload] = splitOnce(data, ";");
    if (!target || payload === null) return false;

    // Every char in `target` is a destination selector (c = clipboard,
    // p = primary, etc.). We only forward when clipboard is one of them.
    const wantsClipboard = [...target].some((ch) => CLIPBOARD_TARGETS.has(ch));
    if (!wantsClipboard) return false;

    if (payload === "?") {
      // Read request. Always ignore; returning false lets xterm handle the
      // (nonexistent) default which is also a no-op.
      return true;
    }

    let text: string;
    try {
      text = atob(payload);
    } catch {
      return true;
    }

    // navigator.clipboard resolves asynchronously; fire-and-forget.
    void navigator.clipboard.writeText(text).catch(() => {
      // Silent failure is acceptable — the OSC sequence itself isn't a
      // user action, so we can't show a visible error.
    });
    return true;
  });
}

function splitOnce(input: string, sep: string): [string, string | null] {
  const idx = input.indexOf(sep);
  if (idx < 0) return [input, null];
  return [input.slice(0, idx), input.slice(idx + 1)];
}
