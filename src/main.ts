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

// ---------- Types ----------

interface Leaf {
  type: "leaf";
  parent: Split | null;
  tab: Tab;
  el: HTMLDivElement;
  termHost: HTMLDivElement;
  sessionId: string | null;
  term: Terminal;
  fit: FitAddon;
  resizeObs: ResizeObserver | null;
  disposers: Array<() => void>;
  mounted: boolean;
  cwd: string;
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

interface Tab {
  id: string;
  el: HTMLDivElement;
  labelEl: HTMLSpanElement;
  closeBtn: HTMLButtonElement;
  root: Pane;
  activeLeaf: Leaf | null;
  broadcast: boolean;
  customName: string | null;
}

// ---------- State ----------

const leavesBySessionId = new Map<string, Leaf>();
const tabs: Tab[] = [];
let activeTab: Tab | null = null;
let tabSeq = 0;

const container = document.getElementById("term")!;
const tabStrip = document.getElementById("tab-strip")!;
const newTabBtn = document.getElementById("new-tab") as HTMLButtonElement;

// ---------- Tab lifecycle ----------

function makeTab(): Tab {
  const id = `t${++tabSeq}`;
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = id;

  const labelEl = document.createElement("span");
  labelEl.className = "tab-label";
  labelEl.textContent = "~";
  el.appendChild(labelEl);

  const closeBtn = document.createElement("button");
  closeBtn.className = "tab-close";
  closeBtn.textContent = "×";
  closeBtn.title = "Close tab";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  el.appendChild(closeBtn);

  const tab: Tab = {
    id, el, labelEl, closeBtn,
    root: null as unknown as Pane, // set below
    activeLeaf: null,
    broadcast: false,
    customName: null,
  };

  const leaf = makeLeaf(tab);
  tab.root = leaf;

  el.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".tab-close")) return;
    activateTab(tab);
  });

  labelEl.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startRenameTab(tab);
  });

  tabStrip.insertBefore(el, newTabBtn);
  tabs.push(tab);
  return tab;
}

function startRenameTab(tab: Tab) {
  const original = tab.customName ?? tab.labelEl.textContent ?? "";
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = original;
  input.spellcheck = false;
  tab.labelEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = (save: boolean) => {
    const v = input.value.trim();
    if (save) tab.customName = v === "" ? null : v;
    input.replaceWith(tab.labelEl);
    updateTabLabel(tab);
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commit(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true));
}

async function openNewTab() {
  const tab = makeTab();
  activateTab(tab);
  if (tab.root.type === "leaf") {
    await mountLeaf(tab.root);
    focusLeaf(tab.root);
  }
}

function activateTab(tab: Tab) {
  if (activeTab === tab) return;
  // detach current
  if (activeTab) {
    activeTab.el.classList.remove("active");
    if (activeTab.root.el.parentElement === container) {
      container.removeChild(activeTab.root.el);
    }
  }
  // attach new
  container.appendChild(tab.root.el);
  tab.el.classList.add("active");
  activeTab = tab;
  // refit + refocus
  forEachLeaf(tab.root, (l) => { try { l.fit.fit(); } catch {} });
  const leafToFocus = tab.activeLeaf ?? firstLeaf(tab.root);
  if (leafToFocus) focusLeaf(leafToFocus);
}

async function closeTab(tab: Tab) {
  // dispose all leaves in this tab
  forEachLeaf(tab.root, disposeLeaf);
  const idx = tabs.indexOf(tab);
  if (idx >= 0) tabs.splice(idx, 1);
  tab.el.remove();
  if (tabs.length === 0) {
    try { await getCurrentWindow().close(); } catch {}
    return;
  }
  if (activeTab === tab) {
    activeTab = null;
    const neighbor = tabs[Math.max(0, Math.min(idx, tabs.length - 1))];
    activateTab(neighbor);
  }
}

function updateTabLabel(tab: Tab) {
  if (tab.customName) {
    tab.labelEl.textContent = tab.customName;
    tab.labelEl.title = tab.customName;
    return;
  }
  const leaf = tab.activeLeaf ?? firstLeaf(tab.root);
  const cwd = leaf?.cwd ?? "~";
  const short = cwd
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
  const base = short.split("/").filter(Boolean).pop() ?? "~";
  tab.labelEl.textContent = short === "~" ? "~" : base;
  tab.labelEl.title = short;
}

// ---------- Leaf ----------

function makeLeaf(tab: Tab): Leaf {
  const el = document.createElement("div");
  el.className = "pane leaf";

  const termHost = document.createElement("div");
  termHost.className = "pane-term";
  el.appendChild(termHost);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize,
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
  // term.open() is deferred to mountLeaf(); xterm's renderer needs the host
  // to be in the DOM with real dimensions or it initializes to 1x1 and never
  // recovers even after resize.

  const leaf: Leaf = {
    type: "leaf",
    parent: null,
    tab,
    el,
    termHost,
    sessionId: null,
    term,
    fit,
    resizeObs: null,
    disposers: [],
    mounted: false,
    cwd: "~",
  };

  el.addEventListener("mousedown", () => focusLeaf(leaf), true);

  term.onTitleChange((title) => {
    const m = title.match(/:\s*(.+)$/);
    leaf.cwd = m ? m[1] : title;
    if (leaf.tab.activeLeaf === leaf) updateTabLabel(leaf.tab);
  });

  return leaf;
}

async function mountLeaf(leaf: Leaf) {
  if (leaf.mounted) return;
  leaf.mounted = true;

  // Element must already be in the DOM at this point — open renderer now.
  leaf.term.open(leaf.termHost);

  leaf.resizeObs = new ResizeObserver(() => {
    try { leaf.fit.fit(); } catch {}
  });
  leaf.resizeObs.observe(leaf.termHost);

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
    const bytes = Array.from(encoder.encode(data));
    // Broadcast mode: write to every leaf in the tab
    if (leaf.tab.broadcast) {
      forEachLeaf(leaf.tab.root, (l) => {
        if (!l.sessionId) return;
        invoke("pty_write", { sessionId: l.sessionId, data: bytes });
      });
    } else {
      invoke("pty_write", { sessionId: leaf.sessionId, data: bytes });
    }
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

// ---------- Tree ops (per-tab) ----------

function replaceInTree(tab: Tab, oldPane: Pane, newPane: Pane) {
  const parent = oldPane.parent;
  newPane.parent = parent;
  if (!parent) {
    tab.root = newPane;
    if (oldPane.el.parentElement === container) {
      container.replaceChild(newPane.el, oldPane.el);
    }
    return;
  }
  const wrapper = parent.a === oldPane ? parent.aEl : parent.bEl;
  wrapper.replaceChild(newPane.el, oldPane.el);
  if (parent.a === oldPane) parent.a = newPane;
  else parent.b = newPane;
}

async function splitActive(dir: "h" | "v") {
  if (!activeTab || !activeTab.activeLeaf) return;
  const tab = activeTab;
  const old = tab.activeLeaf!;
  const neu = makeLeaf(tab);
  const split = makeSplit(dir, old, neu);
  replaceInTree(tab, old, split);
  await mountLeaf(neu);
  focusLeaf(neu);
}

async function closeActivePane() {
  if (!activeTab || !activeTab.activeLeaf) return;
  const tab = activeTab;
  const leaf = tab.activeLeaf!;
  const parent = leaf.parent;
  disposeLeaf(leaf);

  if (!parent) {
    // leaf is the root of the tab — close the whole tab
    await closeTab(tab);
    return;
  }
  const sibling: Pane = parent.a === leaf ? parent.b : parent.a;
  replaceInTree(tab, parent, sibling);
  const next = firstLeaf(sibling);
  if (next) focusLeaf(next);
}

function firstLeaf(p: Pane): Leaf | null {
  if (p.type === "leaf") return p;
  return firstLeaf(p.a) || firstLeaf(p.b);
}

function forEachLeaf(p: Pane, fn: (l: Leaf) => void) {
  if (p.type === "leaf") { fn(p); return; }
  forEachLeaf(p.a, fn);
  forEachLeaf(p.b, fn);
}

// ---------- Focus & navigation ----------

function focusLeaf(leaf: Leaf) {
  const tab = leaf.tab;
  activeTab = tab;
  tab.activeLeaf = leaf;
  forEachLeaf(tab.root, (l) => l.el.classList.toggle("active", l === leaf));
  leaf.term.focus();
  updateTabLabel(tab);
}

function navigate(dir: "left" | "right" | "up" | "down") {
  if (!activeTab?.activeLeaf) return;
  const active = activeTab.activeLeaf;
  const r = active.el.getBoundingClientRect();
  const cx = (r.left + r.right) / 2;
  const cy = (r.top + r.bottom) / 2;

  let best: Leaf | null = null;
  let bestDist = Infinity;
  forEachLeaf(activeTab.root, (l) => {
    if (l === active) return;
    const rr = l.el.getBoundingClientRect();
    if (dir === "left"  && rr.right > r.left - 1) return;
    if (dir === "right" && rr.left  < r.right + 1) return;
    if (dir === "up"    && rr.bottom > r.top - 1) return;
    if (dir === "down"  && rr.top    < r.bottom + 1) return;
    const lcx = (rr.left + rr.right) / 2;
    const lcy = (rr.top + rr.bottom) / 2;
    const dist = Math.hypot(lcx - cx, lcy - cy);
    if (dist < bestDist) { bestDist = dist; best = l; }
  });
  if (best) focusLeaf(best);
}

function cycleTab(offset: number) {
  if (tabs.length === 0 || !activeTab) return;
  const i = tabs.indexOf(activeTab);
  const next = tabs[(i + offset + tabs.length) % tabs.length];
  activateTab(next);
}

function toggleBroadcast() {
  if (!activeTab) return;
  activeTab.broadcast = !activeTab.broadcast;
  activeTab.el.classList.toggle("broadcasting", activeTab.broadcast);
  forEachLeaf(activeTab.root, (l) =>
    l.el.classList.toggle("broadcasting", activeTab!.broadcast),
  );
}

function clearActive() {
  if (activeTab?.activeLeaf) {
    activeTab.activeLeaf.term.clear();
  }
}

// Font size zoom, persisted
const FONT_KEY = "napkin:fontSize";
let fontSize = parseInt(localStorage.getItem(FONT_KEY) ?? "14", 10) || 14;

function applyFontSize() {
  localStorage.setItem(FONT_KEY, String(fontSize));
  for (const l of allLeavesAcrossTabs()) {
    l.term.options.fontSize = fontSize;
    try { l.fit.fit(); } catch {}
  }
}

function allLeavesAcrossTabs(): Leaf[] {
  const out: Leaf[] = [];
  for (const t of tabs) forEachLeaf(t.root, (l) => out.push(l));
  return out;
}

function bumpFontSize(delta: number) {
  fontSize = Math.max(9, Math.min(28, fontSize + delta));
  applyFontSize();
}

function activateTabByIndex(idx: number) {
  if (idx < 0 || idx >= tabs.length) return;
  activateTab(tabs[idx]);
}

// ---------- Keyboard ----------

window.addEventListener("keydown", (e) => {
  if (!e.metaKey) return;
  const k = e.key.toLowerCase();

  if (k === "t" && !e.shiftKey) { openNewTab(); e.preventDefault(); return; }
  if (k === "d" && !e.shiftKey) { splitActive("h"); e.preventDefault(); return; }
  if (k === "d" &&  e.shiftKey) { splitActive("v"); e.preventDefault(); return; }
  if (k === "w" && !e.shiftKey) { closeActivePane(); e.preventDefault(); return; }
  if (k === "k" && !e.shiftKey) { clearActive(); e.preventDefault(); return; }
  if (k === "b" &&  e.shiftKey) { toggleBroadcast(); e.preventDefault(); return; }

  if (!e.shiftKey && (k === "=" || k === "+")) { bumpFontSize(+1); e.preventDefault(); return; }
  if (!e.shiftKey && (k === "-" || k === "_")) { bumpFontSize(-1); e.preventDefault(); return; }
  if (!e.shiftKey && k === "0") { fontSize = 14; applyFontSize(); e.preventDefault(); return; }

  if (e.shiftKey) {
    if (k === "arrowleft")  { navigate("left");  e.preventDefault(); return; }
    if (k === "arrowright") { navigate("right"); e.preventDefault(); return; }
    if (k === "arrowup")    { navigate("up");    e.preventDefault(); return; }
    if (k === "arrowdown")  { navigate("down");  e.preventDefault(); return; }
    if (k === "[" || k === "{") { cycleTab(-1); e.preventDefault(); return; }
    if (k === "]" || k === "}") { cycleTab(+1); e.preventDefault(); return; }
  }

  // Cmd+1..9
  if (!e.shiftKey && /^[1-9]$/.test(k)) {
    activateTabByIndex(parseInt(k, 10) - 1);
    e.preventDefault();
    return;
  }
}, true);

// ---------- Boot ----------

async function boot() {
  await listen<PtyOutput>("pty-output", (ev) => {
    const leaf = leavesBySessionId.get(ev.payload.session_id);
    if (!leaf) return;
    leaf.term.write(decoder.decode(new Uint8Array(ev.payload.data)));
  });

  await listen<{ session_id: string; cwd: string }>("pane-cwd", (ev) => {
    const leaf = leavesBySessionId.get(ev.payload.session_id);
    if (!leaf) return;
    leaf.cwd = ev.payload.cwd;
    if (leaf.tab.activeLeaf === leaf) updateTabLabel(leaf.tab);
  });

  await listen<{ session_id: string }>("pty-exit", (ev) => {
    const leaf = leavesBySessionId.get(ev.payload.session_id);
    if (!leaf) return;
    leaf.term.writeln("\r\n\x1b[90m[napkin] session exited\x1b[0m");
    setTimeout(() => {
      // if this is the active leaf in its tab and it's the only pane, close the tab
      const parent = leaf.parent;
      const tab = leaf.tab;
      disposeLeaf(leaf);
      if (!parent) {
        closeTab(tab);
        return;
      }
      const sibling: Pane = parent.a === leaf ? parent.b : parent.a;
      replaceInTree(tab, parent, sibling);
      const next = firstLeaf(sibling);
      if (next && activeTab === tab) focusLeaf(next);
    }, 400);
  });

  newTabBtn.addEventListener("click", () => openNewTab());

  const t = makeTab();
  activateTab(t);
  if (t.root.type === "leaf") {
    await mountLeaf(t.root);
    focusLeaf(t.root);
  }
}

window.addEventListener("resize", () => {
  if (!activeTab) return;
  forEachLeaf(activeTab.root, (l) => { try { l.fit.fit(); } catch {} });
});

// ---------- Visible error surface (since devtools is off) ----------

function showError(msg: string) {
  let box = document.getElementById("napkin-error-box");
  if (!box) {
    box = document.createElement("div");
    box.id = "napkin-error-box";
    box.style.cssText =
      "position:fixed;top:48px;left:12px;right:12px;max-height:40vh;overflow:auto;" +
      "background:#2a0f0f;color:#ff9999;padding:12px 14px;border:1px solid #552;" +
      "border-radius:8px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;" +
      "z-index:99999;user-select:text;";
    document.body.appendChild(box);
  }
  box.textContent += (box.textContent ? "\n\n" : "") + msg;
}

window.addEventListener("error", (e) => {
  showError(`[error] ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ""}`);
});
window.addEventListener("unhandledrejection", (e: any) => {
  showError(`[promise] ${e.reason?.stack ?? e.reason}`);
});

boot().catch((e: any) => {
  showError(`[boot failed] ${e?.stack ?? e}`);
});
