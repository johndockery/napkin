import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";

import { killPty, resizePty, spawnPty, subscribePty, writePty } from "./ipc.ts";
import { registerFilePathLinks } from "./links.ts";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_THEME,
} from "./theme.ts";
import type {
  LeafPane,
  NavigationDirection,
  PaneNode,
  SplitDirection,
  SplitPane,
  Tab,
} from "./types.ts";

const inputEncoder = new TextEncoder();

export interface CreateLeafPaneOptions {
  readonly fontSize: number;
  readonly onCwdChange: (leaf: LeafPane) => void;
  readonly onFocusRequested: (leaf: LeafPane) => void;
}

export interface LeafIoOptions {
  readonly leavesBySessionId: Map<string, LeafPane>;
  readonly getBroadcastTargets: (leaf: LeafPane) => ReadonlyArray<LeafPane>;
  readonly reportInvokeError: (context: string, error: unknown) => void;
  /** When set, attach to this existing daemon session instead of spawning. */
  readonly existingSessionId?: string;
}

export function attachLinkProviders(
  leaf: LeafPane,
  reportError: (context: string, error: unknown) => void,
): void {
  registerFilePathLinks(leaf.terminal, reportError);
}

export function createLeafPane(
  tab: Tab,
  options: CreateLeafPaneOptions,
): LeafPane {
  const element = document.createElement("div");
  element.className = "pane leaf";

  const terminalHostElement = document.createElement("div");
  terminalHostElement.className = "pane-term";
  element.appendChild(terminalHostElement);

  const terminal = new Terminal({
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: options.fontSize,
    lineHeight: 1.35,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10_000,
    smoothScrollDuration: 80,
    allowTransparency: true,
    theme: TERMINAL_THEME,
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const imageAddon = new ImageAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(imageAddon);
  terminal.loadAddon(new WebLinksAddon());

  let leaf!: LeafPane;
  const titleChangeDisposable = terminal.onTitleChange((title) => {
    leaf.cwd = parseWorkingDirectoryFromTitle(title);
    options.onCwdChange(leaf);
  });

  leaf = {
    type: "leaf",
    parent: null,
    tab,
    element,
    terminalHostElement,
    terminal,
    fitAddon,
    searchAddon,
    cleanup: [
      () => titleChangeDisposable.dispose(),
      () => searchAddon.dispose(),
      () => imageAddon.dispose(),
    ],
    resizeObserver: null,
    sessionId: null,
    mountState: "new",
    cwd: "~",
    runState: "idle",
    agent: null,
    promptMarks: [],
  };

  element.addEventListener("mousedown", () => options.onFocusRequested(leaf), true);

  return leaf;
}

export async function mountLeafPane(
  leaf: LeafPane,
  options: LeafIoOptions,
): Promise<void> {
  if (leaf.mountState !== "new") {
    return;
  }

  leaf.mountState = "mounting";

  // xterm needs a mounted host with real dimensions before open() or it can
  // initialize against a 1x1 box and stay stuck there.
  leaf.terminal.open(leaf.terminalHostElement);
  attachLinkProviders(leaf, options.reportInvokeError);

  leaf.resizeObserver = new ResizeObserver(() => {
    fitLeafPane(leaf);
  });
  leaf.resizeObserver.observe(leaf.terminalHostElement);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  fitLeafPane(leaf);

  const rows = Math.max(1, leaf.terminal.rows);
  const cols = Math.max(1, leaf.terminal.cols);

  let sessionId: string;
  if (options.existingSessionId) {
    sessionId = options.existingSessionId;
    try {
      await subscribePty(sessionId, rows, cols);
    } catch (error) {
      // Session vanished from the daemon (shell exited before we could
      // reattach). Fall back to spawning a fresh one.
      options.reportInvokeError(`pty_subscribe(${sessionId})`, error);
      sessionId = await spawnPty({ rows, cols });
    }
  } else {
    sessionId = await spawnPty({ rows, cols });
  }

  if (isLeafDisposed(leaf)) {
    void killPty(sessionId).catch((error) => {
      options.reportInvokeError(`pty_kill(${sessionId})`, error);
    });
    return;
  }

  leaf.sessionId = sessionId;
  options.leavesBySessionId.set(sessionId, leaf);

  const dataDisposable = leaf.terminal.onData((data) => {
    const payload = Array.from(inputEncoder.encode(data));
    const targets = leaf.tab.broadcastInput
      ? options.getBroadcastTargets(leaf)
      : [leaf];

    for (const target of targets) {
      if (!target.sessionId) {
        continue;
      }
      void writePty(target.sessionId, payload).catch((error) => {
        options.reportInvokeError(`pty_write(${target.sessionId})`, error);
      });
    }
  });

  const resizeDisposable = leaf.terminal.onResize(({ rows, cols }) => {
    if (!leaf.sessionId) {
      return;
    }
    void resizePty(leaf.sessionId, rows, cols).catch((error) => {
      options.reportInvokeError(`pty_resize(${leaf.sessionId})`, error);
    });
  });

  leaf.cleanup.push(
    () => dataDisposable.dispose(),
    () => resizeDisposable.dispose(),
  );
  leaf.mountState = "ready";
}

export function disposeLeafPane(
  leaf: LeafPane,
  options: Pick<LeafIoOptions, "leavesBySessionId" | "reportInvokeError">,
): void {
  if (leaf.mountState === "disposed") {
    return;
  }

  leaf.mountState = "disposed";
  leaf.resizeObserver?.disconnect();
  leaf.resizeObserver = null;

  for (const cleanup of leaf.cleanup.splice(0)) {
    try {
      cleanup();
    } catch {
      // Cleanup should never block pane teardown.
    }
  }

  const sessionId = leaf.sessionId;
  leaf.sessionId = null;

  if (sessionId) {
    options.leavesBySessionId.delete(sessionId);
    void killPty(sessionId).catch((error) => {
      options.reportInvokeError(`pty_kill(${sessionId})`, error);
    });
  }

  leaf.terminal.dispose();
}

export function createSplitPane(
  direction: SplitDirection,
  a: PaneNode,
  b: PaneNode,
): SplitPane {
  const element = document.createElement("div");
  element.className = `pane split ${direction}`;

  const aElement = document.createElement("div");
  aElement.className = "split-cell";
  aElement.appendChild(a.element);

  const bElement = document.createElement("div");
  bElement.className = "split-cell";
  bElement.appendChild(b.element);

  const resizerElement = document.createElement("div");
  resizerElement.className = "split-resizer";

  element.append(aElement, resizerElement, bElement);

  const split: SplitPane = {
    type: "split",
    parent: null,
    direction,
    ratio: 0.5,
    a,
    b,
    element,
    aElement,
    bElement,
    resizerElement,
  };
  a.parent = split;
  b.parent = split;

  applySplitRatio(split);
  attachSplitResizer(split);

  return split;
}

export function replacePaneInTree(
  tab: Tab,
  oldPane: PaneNode,
  newPane: PaneNode,
  container: HTMLDivElement,
): void {
  const parent = oldPane.parent;
  newPane.parent = parent;

  if (!parent) {
    tab.root = newPane;
    // Deferred exit handlers can race with tab switches and close paths, so
    // only replace the DOM root if this tab is still mounted in the viewport.
    if (oldPane.element.parentElement === container) {
      container.replaceChild(newPane.element, oldPane.element);
    }
    return;
  }

  const wrapper = parent.a === oldPane ? parent.aElement : parent.bElement;
  wrapper.replaceChild(newPane.element, oldPane.element);

  if (parent.a === oldPane) {
    parent.a = newPane;
  } else {
    parent.b = newPane;
  }
}

export function findFirstLeaf(pane: PaneNode): LeafPane | null {
  if (pane.type === "leaf") {
    return pane;
  }
  return findFirstLeaf(pane.a) ?? findFirstLeaf(pane.b);
}

export function forEachLeaf(
  pane: PaneNode,
  visit: (leaf: LeafPane) => void,
): void {
  if (pane.type === "leaf") {
    visit(pane);
    return;
  }
  forEachLeaf(pane.a, visit);
  forEachLeaf(pane.b, visit);
}

export function findAdjacentLeaf(
  root: PaneNode,
  activeLeaf: LeafPane,
  direction: NavigationDirection,
): LeafPane | null {
  const activeBounds = activeLeaf.element.getBoundingClientRect();
  const activeCenterX = (activeBounds.left + activeBounds.right) / 2;
  const activeCenterY = (activeBounds.top + activeBounds.bottom) / 2;

  let bestLeaf: LeafPane | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  forEachLeaf(root, (leaf) => {
    if (leaf === activeLeaf) {
      return;
    }

    const bounds = leaf.element.getBoundingClientRect();
    if (direction === "left" && bounds.right > activeBounds.left - 1) {
      return;
    }
    if (direction === "right" && bounds.left < activeBounds.right + 1) {
      return;
    }
    if (direction === "up" && bounds.bottom > activeBounds.top - 1) {
      return;
    }
    if (direction === "down" && bounds.top < activeBounds.bottom + 1) {
      return;
    }

    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    const distance = Math.hypot(centerX - activeCenterX, centerY - activeCenterY);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestLeaf = leaf;
    }
  });

  return bestLeaf;
}

export function fitLeafPane(leaf: LeafPane): void {
  try {
    leaf.fitAddon.fit();
  } catch {
    // xterm can report transient fit errors while panes are collapsing.
  }
}

export function setLeafFontSize(leaf: LeafPane, fontSize: number): void {
  leaf.terminal.options.fontSize = fontSize;
  fitLeafPane(leaf);
}

function applySplitRatio(split: SplitPane): void {
  const primaryPercent = Math.max(10, Math.min(90, split.ratio * 100));
  const secondaryPercent = 100 - primaryPercent;

  if (split.direction === "horizontal") {
    split.element.style.gridTemplateColumns =
      `${primaryPercent}% 6px ${secondaryPercent}%`;
    split.element.style.gridTemplateRows = "";
    return;
  }

  split.element.style.gridTemplateRows =
    `${primaryPercent}% 6px ${secondaryPercent}%`;
  split.element.style.gridTemplateColumns = "";
}

function attachSplitResizer(split: SplitPane): void {
  split.resizerElement.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const bounds = split.element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startRatio = split.ratio;
    const size = split.direction === "horizontal" ? bounds.width : bounds.height;

    document.body.style.cursor =
      split.direction === "horizontal" ? "col-resize" : "row-resize";

    const onMove = (moveEvent: MouseEvent) => {
      const delta = split.direction === "horizontal"
        ? moveEvent.clientX - startX
        : moveEvent.clientY - startY;
      split.ratio = Math.min(0.9, Math.max(0.1, startRatio + delta / size));
      applySplitRatio(split);
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

function parseWorkingDirectoryFromTitle(title: string): string {
  const match = title.match(/:\s*(.+)$/);
  return match ? match[1] : title;
}

function isLeafDisposed(leaf: LeafPane): boolean {
  return leaf.mountState === "disposed";
}
