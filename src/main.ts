import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type PtyOutput = { session_id: string; data: number[] };

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontSize: 14,
  lineHeight: 1.35,
  letterSpacing: 0,
  cursorBlink: true,
  cursorStyle: "bar",
  cursorWidth: 2,
  scrollback: 10_000,
  smoothScrollDuration: 80,
  allowTransparency: true,
  theme: {
    background: "rgba(0,0,0,0)",
    foreground: "#e6e6e6",
    cursor: "#f5a742",
    cursorAccent: "#0b0c0f",
    selectionBackground: "rgba(245, 167, 66, 0.22)",
    selectionForeground: "#ffffff",
    black: "#1c1c1c",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#dcdfe4",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());

const container = document.getElementById("term")!;
term.open(container);
queueMicrotask(() => fit.fit());

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let sessionId: string | null = null;
const cwdEl = document.getElementById("chrome-cwd");

function setCwd(path: string) {
  if (!cwdEl) return;
  const home = "~";
  const display = path
    .replace(/^\/Users\/[^/]+/, home)
    .replace(/^\/home\/[^/]+/, home);
  cwdEl.textContent = display || "~";
}

async function boot() {
  await listen<PtyOutput>("pty-output", (ev) => {
    if (ev.payload.session_id !== sessionId) return;
    term.write(decoder.decode(new Uint8Array(ev.payload.data)));
  });

  await listen<{ session_id: string }>("pty-exit", (ev) => {
    if (ev.payload.session_id !== sessionId) return;
    term.writeln("\r\n\x1b[90m[napkin] session exited\x1b[0m");
    sessionId = null;
  });

  sessionId = await invoke<string>("pty_spawn", {
    args: {
      rows: term.rows,
      cols: term.cols,
    },
  });

  term.onData((data) => {
    if (!sessionId) return;
    const bytes = Array.from(encoder.encode(data));
    invoke("pty_write", { sessionId, data: bytes });
  });

  term.onResize(({ rows, cols }) => {
    if (!sessionId) return;
    invoke("pty_resize", { sessionId, rows, cols });
  });

  // Title/cwd updates from shell (OSC 0 / OSC 7)
  term.onTitleChange((title) => {
    // OSC 0 is window title — often set to "user@host: cwd"
    const m = title.match(/:\s*(.+)$/);
    if (m) setCwd(m[1]);
    else setCwd(title);
  });

  term.focus();
}

window.addEventListener("resize", () => fit.fit());

boot().catch((e) => {
  term.writeln(`\r\n\x1b[31m[napkin] boot failed: ${e}\x1b[0m`);
});
