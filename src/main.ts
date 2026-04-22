import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

type PtyOutput = { session_id: string; data: number[] };

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const termTheme = {
  background: "rgba(0,0,0,0)",
  foreground: "#e6e6e6",
  cursor: "#f5a742",
  cursorAccent: "#0b0c0f",
  selectionBackground: "rgba(245, 167, 66, 0.22)",
  selectionForeground: "#ffffff",
  black: "#1c1c1c", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#dcdfe4",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
  brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
  brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

interface Leaf {
  type: "leaf";
  parent: Split | null;
  el: HTMLDivElement;
  termHost: HTMLDivElement;
  sessionId: string | null;
  term: Terminal;
  fit: FitAddon;
  resizeObs: ResizeObserver | null;
  disposers: Array<() => void>;
  mounted: boolean;
}

interface Split {
  type: "split";
  parent: Split | null;
  dir: "h" | "v";
  ratio: number;
  a: Pane;
  b: Pane;
  el: HTMLDivElement;
  aEl: HTMLDivElement;
  bEl: HTMLDivElement;
  resizerEl: HTMLDivElement;
}

type Pane = Leaf | Split;

const leavesBySessionId = new Map<string, Leaf>();
const allLeaves = new Set<Leaf>();
let activeLeaf: Leaf | null = null;
let root: Pane | null = null;
const container = document.getElementById("term")!;
const cwdEl = document.getElementById("chrome-cwd");

// ---------- Chrome ----------

function setCwd(path: string) {
  if (!cwdEl) return;
  const display = path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
  cwdEl.textContent = display || "~";
}

// ---------- Leaf ----------

function makeLeaf(): Leaf {
  const el = document.createElement("div");
  el.className = "pane leaf";

  const termHost = document.createElement("div");
  termHost.className = "pane-term";
  el.appendChild(termHost);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize: 14,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10_000,
    smoothScrollDuration: 80,
    allowTransparency: true,
    theme: termTheme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(termHost);

  const leaf: Leaf = {
    type: "leaf",
    parent: null,
    el,
    termHost,
    sessionId: null,
    term,
    fit,
    resizeObs: null,
    disposers: [],
    mounted: false,
  };

  el.addEventListener("mousedown", () => focusLeaf(leaf), true);

  term.onTitleChange((title) => {
    if (activeLeaf !== leaf) return;
    const m = title.match(/:\s*(.+)$/);
    setCwd(m ? m[1] : title);
  });

  allLeaves.add(leaf);
  return leaf;
}

async function mountLeaf(leaf: Leaf) {
  if (leaf.mounted) return;
  leaf.mounted = true;

  // ResizeObserver keeps xterm cell grid in sync with the host
  leaf.resizeObs = new ResizeObserver(() => {
    try { leaf.fit.fit(); } catch {}
  });
  leaf.resizeObs.observe(leaf.termHost);

  // Wait one frame so the host has a real size
  await new Promise(requestAnimationFrame);
  try { leaf.fit.fit(); } catch {}

  const rows = Math.max(1, leaf.term.rows);
  const cols = Math.max(1, leaf.term.cols);

  const sid = await invoke<string>("pty_spawn", {
    args: { rows, cols },
  });
  leaf.sessionId = sid;
  leavesBySessionId.set(sid, leaf);

  const d1 = leaf.term.onData((data) => {
    if (!leaf.sessionId) return;
    invoke("pty_write", {
      sessionId: leaf.sessionId,
      data: Array.from(encoder.encode(data)),
    });
  });
  const d2 = leaf.term.onResize(({ rows, cols }) => {
    if (!leaf.sessionId) return;
    invoke("pty_resize", { sessionId: leaf.sessionId, rows, cols });
  });
  leaf.disposers.push(() => d1.dispose(), () => d2.dispose());
}

function disposeLeaf(leaf: Leaf) {
  leaf.resizeObs?.disconnect();
  leaf.disposers.forEach((fn) => { try { fn(); } catch {} });
  if (leaf.sessionId) {
    invoke("pty_kill", { sessionId: leaf.sessionId }).catch(() => {});
    leavesBySessionId.delete(leaf.sessionId);
  }
  leaf.term.dispose();
  allLeaves.delete(leaf);
}

// ---------- Split ----------

function makeSplit(dir: "h" | "v", a: Pane, b: Pane): Split {
  const el = document.createElement("div");
  el.className = `pane split ${dir}`;

  const aEl = document.createElement("div");
  aEl.className = "split-cell";
  aEl.appendChild(a.el);

  const bEl = document.createElement("div");
  bEl.className = "split-cell";
  bEl.appendChild(b.el);

  const resizerEl = document.createElement("div");
  resizerEl.className = "split-resizer";

  el.appendChild(aEl);
  el.appendChild(resizerEl);
  el.appendChild(bEl);

  const split: Split = {
    type: "split",
    parent: null,
    dir,
    ratio: 0.5,
    a, b, el, aEl, bEl, resizerEl,
  };
  a.parent = split;
  b.parent = split;
  applyRatio(split);
  attachResizerDrag(split);
  return split;
}

function applyRatio(s: Split) {
  const pct = Math.max(10, Math.min(90, s.ratio * 100));
  const rest = 100 - pct;
  if (s.dir === "h") {
    s.el.style.gridTemplateColumns = `${pct}% 6px ${rest}%`;
    s.el.style.gridTemplateRows = "";
  } else {
    s.el.style.gridTemplateRows = `${pct}% 6px ${rest}%`;
    s.el.style.gridTemplateColumns = "";
  }
}

function attachResizerDrag(s: Split) {
  s.resizerEl.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = s.el.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const startRatio = s.ratio;
    const size = s.dir === "h" ? rect.width : rect.height;
    document.body.style.cursor = s.dir === "h" ? "col-resize" : "row-resize";
    const onMove = (e: MouseEvent) => {
      const delta = s.dir === "h" ? e.clientX - startX : e.clientY - startY;
      s.ratio = Math.min(0.9, Math.max(0.1, startRatio + delta / size));
      applyRatio(s);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// ---------- Tree operations ----------

function replaceInTree(oldPane: Pane, newPane: Pane) {
  const parent = oldPane.parent;
  newPane.parent = parent;
  if (!parent) {
    root = newPane;
    container.replaceChild(newPane.el, oldPane.el);
    return;
  }
  const wrapper = parent.a === oldPane ? parent.aEl : parent.bEl;
  wrapper.replaceChild(newPane.el, oldPane.el);
  if (parent.a === oldPane) parent.a = newPane;
  else parent.b = newPane;
}

function splitActive(dir: "h" | "v") {
  if (!activeLeaf) return;
  const old = activeLeaf;
  const neu = makeLeaf();
  const split = makeSplit(dir, old, neu);
  replaceInTree(old, split);
  mountLeaf(neu);
  focusLeaf(neu);
}

async function closePane(leaf: Leaf) {
  const parent = leaf.parent;
  disposeLeaf(leaf);

  if (!parent) {
    // Last pane — close the window
    try { await getCurrentWindow().close(); } catch {}
    return;
  }

  const sibling: Pane = parent.a === leaf ? parent.b : parent.a;
  // The sibling takes the grandparent's slot (or becomes root)
  replaceInTree(parent, sibling);
  const next = firstLeaf(sibling);
  if (next) focusLeaf(next);
}

function firstLeaf(p: Pane): Leaf | null {
  if (p.type === "leaf") return p;
  return firstLeaf(p.a) || firstLeaf(p.b);
}

// ---------- Focus & navigation ----------

function focusLeaf(leaf: Leaf) {
  activeLeaf = leaf;
  for (const l of allLeaves) {
    l.el.classList.toggle("active", l === leaf);
  }
  leaf.term.focus();
}

function navigate(dir: "left" | "right" | "up" | "down") {
  if (!activeLeaf) return;
  const r = activeLeaf.el.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;

  let best: Leaf | null = null;
  let bestDist = Infinity;
  for (const l of allLeaves) {
    if (l === activeLeaf) continue;
    const rr = l.el.getBoundingClientRect();
    if (dir === "left" && rr.right > r.left - 1) continue;
    if (dir === "right" && rr.left < r.right + 1) continue;
    if (dir === "up" && rr.bottom > r.top - 1) continue;
    if (dir === "down" && rr.top < r.bottom + 1) continue;
    const lcx = (rr.left + rr.right) / 2;
    const lcy = (rr.top + rr.bottom) / 2;
    const dist = Math.hypot(lcx - cx, lcy - cy);
    if (dist < bestDist) { bestDist = dist; best = l; }
  }
  if (best) focusLeaf(best);
}

// ---------- Keyboard ----------

window.addEventListener("keydown", (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();

  if (k === "d" && !e.shiftKey) { splitActive("h"); e.preventDefault(); return; }
  if (k === "d" &&  e.shiftKey) { splitActive("v"); e.preventDefault(); return; }

  if (k === "w") {
    if (activeLeaf) closePane(activeLeaf);
    e.preventDefault();
    return;
  }

  if (e.shiftKey) {
    if (k === "arrowleft")  { navigate("left");  e.preventDefault(); return; }
    if (k === "arrowright") { navigate("right"); e.preventDefault(); return; }
    if (k === "arrowup")    { navigate("up");    e.preventDefault(); return; }
    if (k === "arrowdown")  { navigate("down");  e.preventDefault(); return; }
  }
}, true);

// ---------- Boot ----------

async function boot() {
  await listen<PtyOutput>("pty-output", (ev) => {
    const leaf = leavesBySessionId.get(ev.payload.session_id);
    if (!leaf) return;
    leaf.term.write(decoder.decode(new Uint8Array(ev.payload.data)));
  });

  await listen<{ session_id: string }>("pty-exit", (ev) => {
    const leaf = leavesBySessionId.get(ev.payload.session_id);
    if (!leaf) return;
    leaf.term.writeln("\r\n\x1b[90m[napkin] session exited\x1b[0m");
    setTimeout(() => closePane(leaf), 400);
  });

  const first = makeLeaf();
  root = first;
  container.appendChild(first.el);
  await mountLeaf(first);
  focusLeaf(first);
}

window.addEventListener("resize", () => {
  for (const l of allLeaves) {
    try { l.fit.fit(); } catch {}
  }
});

boot().catch((e) => {
  console.error("napkin boot failed:", e);
});
