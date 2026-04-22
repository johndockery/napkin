import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ErrorReporter } from "./errors.ts";
import {
  listPtySessions,
  loadConfig,
  onPaneAgent,
  onPaneCwd,
  onPaneMark,
  onPaneStatus,
  onPtyExit,
  onPtyOutput,
} from "./ipc.ts";
import { createNotificationGate } from "./notifications.ts";
import { createCommandPalette, type CommandEntry } from "./commands.ts";
import { applyTabColor, openTabColorMenu } from "./tab-colors.ts";
import { createHelpOverlay } from "./help.ts";
import { createPanePalette, type PalettePaneEntry } from "./palette.ts";
import { createSearchController } from "./search.ts";
import { registerKeybindings } from "./keybindings.ts";
import {
  createLeafPane,
  createSplitPane,
  disposeLeafPane,
  findAdjacentLeaf,
  findFirstLeaf,
  fitLeafPane,
  forEachLeaf,
  mountLeafPane,
  replacePaneInTree,
  setLeafFontSize,
} from "./panes.ts";
import {
  bindTabEvents,
  createTabElements,
  mountTab,
  setTabAgent,
  setTabRunState,
  startTabRename,
  updateTabLabel,
} from "./tabs.ts";
import {
  applyConfig,
  clampFontSize,
  DEFAULT_FONT_SIZE,
  loadFontSize,
  saveFontSize,
} from "./theme.ts";
import type {
  AppElements,
  AppState,
  LeafPane,
  NavigationDirection,
  PaneRunState,
  SplitDirection,
  Tab,
} from "./types.ts";
import { getTabRoot } from "./types.ts";

const outputDecoder = new TextDecoder();

/**
 * Agent hooks send free-form state strings; map them to the UI's state
 * enum. Unknown states collapse to "idle".
 */
function normalizeStatusState(raw: string): PaneRunState {
  switch (raw.toLowerCase()) {
    case "working":
    case "running":
    case "thinking":
      return "running";
    case "waiting":
    case "waiting_input":
    case "needs_input":
      return "waiting";
    case "done":
    case "ok":
    case "completed":
      return "ok";
    case "error":
    case "errored":
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export async function bootWorkspace(
  elements: AppElements,
  reporter: ErrorReporter,
): Promise<void> {
  let rawConfig: unknown = {};
  try {
    rawConfig = await loadConfig();
  } catch (error) {
    reporter.report("failed to load config", error, { level: "warn" });
  }
  const config = applyConfig(rawConfig);

  const storedFontSize = window.localStorage.getItem("napkin:fontSize");
  const initialFontSize =
    storedFontSize !== null ? loadFontSize(window.localStorage) : config.initialFontSize;

  const state: AppState = {
    elements,
    leavesBySessionId: new Map<string, LeafPane>(),
    tabs: [],
    activeTab: null,
    nextTabId: 0,
    fontSize: initialFontSize,
  };

  const runAsync = (
    action: () => Promise<void>,
    context: string,
    sticky = false,
  ): void => {
    void action().catch((error) => {
      reporter.report(context, error, {
        toast: true,
        sticky,
      });
    });
  };

  const reportInvokeError = (context: string, error: unknown): void => {
    reporter.report(context, error, { level: "warn" });
  };

  const notifications = createNotificationGate(window);

  const search = createSearchController(document, {
    getActiveLeaf: () => state.activeTab?.activeLeaf ?? null,
  });

  const help = createHelpOverlay(document);

  const commandPalette = createCommandPalette(document, {
    listCommands: (): CommandEntry[] => [
      {
        id: "new-tab",
        category: "Tabs",
        title: "New tab",
        shortcut: "⌘T",
        run: () => runAsync(() => openNewTab(), "failed to open new tab"),
      },
      {
        id: "close-pane",
        category: "Tabs",
        title: "Close pane",
        shortcut: "⌘W",
        run: () => runAsync(() => closeActivePane(), "failed to close pane"),
      },
      {
        id: "next-tab",
        category: "Tabs",
        title: "Next tab",
        shortcut: "⌘⇧]",
        run: () => cycleTab(1),
      },
      {
        id: "previous-tab",
        category: "Tabs",
        title: "Previous tab",
        shortcut: "⌘⇧[",
        run: () => cycleTab(-1),
      },
      {
        id: "rename-tab",
        category: "Tabs",
        title: "Rename tab",
        run: () => {
          if (state.activeTab) {
            startTabRename(state.activeTab, () => updateTabLabel(state.activeTab!));
          }
        },
      },
      {
        id: "split-horizontal",
        category: "Panes",
        title: "Split pane horizontally",
        shortcut: "⌘D",
        run: () =>
          runAsync(() => splitActive("horizontal"), "failed to split pane"),
      },
      {
        id: "split-vertical",
        category: "Panes",
        title: "Split pane vertically",
        shortcut: "⌘⇧D",
        run: () =>
          runAsync(() => splitActive("vertical"), "failed to split pane"),
      },
      {
        id: "clear-pane",
        category: "Panes",
        title: "Clear active pane",
        shortcut: "⌘K",
        run: () => clearActive(),
      },
      {
        id: "toggle-broadcast",
        category: "Panes",
        title: state.activeTab?.broadcastInput
          ? "Turn broadcast input off"
          : "Turn broadcast input on",
        shortcut: "⌘⇧B",
        run: () => toggleBroadcast(),
      },
      {
        id: "pane-palette",
        category: "Navigate",
        title: "Go to pane…",
        shortcut: "⌘P",
        run: () => palette.toggle("all"),
      },
      {
        id: "agent-palette",
        category: "Navigate",
        title: "Go to agent…",
        shortcut: "⌘⇧A",
        run: () => palette.toggle("agents"),
      },
      {
        id: "jump-waiting-agent",
        category: "Navigate",
        title: "Jump to next waiting agent",
        shortcut: "⌘J",
        run: () => jumpToWaitingAgent(),
      },
      {
        id: "jump-prompt-up",
        category: "Navigate",
        title: "Jump to previous prompt",
        shortcut: "⌘↑",
        run: () => jumpToPrompt("previous"),
      },
      {
        id: "jump-prompt-down",
        category: "Navigate",
        title: "Jump to next prompt",
        shortcut: "⌘↓",
        run: () => jumpToPrompt("next"),
      },
      {
        id: "search-pane",
        category: "Navigate",
        title: "Search within pane",
        shortcut: "⌘F",
        run: () => search.toggle(),
      },
      {
        id: "font-bigger",
        category: "Display",
        title: "Font: bigger",
        shortcut: "⌘=",
        run: () => bumpFontSize(1),
      },
      {
        id: "font-smaller",
        category: "Display",
        title: "Font: smaller",
        shortcut: "⌘-",
        run: () => bumpFontSize(-1),
      },
      {
        id: "font-reset",
        category: "Display",
        title: "Font: reset",
        shortcut: "⌘0",
        run: () => resetFontSize(),
      },
      {
        id: "toggle-help",
        category: "Help",
        title: "Show keyboard shortcuts",
        shortcut: "⌘/",
        run: () => help.toggle(),
      },
      {
        id: "add-bookmark",
        category: "Scrollback",
        title: "Bookmark current scrollback position",
        shortcut: "⌘⇧M",
        run: () => addBookmark(),
      },
      // Bookmarks for the active leaf are injected dynamically at the end
      // so they land in the palette under a "Bookmarks" section and route
      // straight to a jump.
      ...(state.activeTab?.activeLeaf?.bookmarks ?? []).map((mark, index) => ({
        id: `bookmark-${state.activeTab!.id}-${index}`,
        category: "Bookmarks",
        title: mark.label,
        run: () => jumpToBookmark(state.activeTab!.activeLeaf!, mark.line),
      })),
    ],
  });

  const listLeaves = (): LeafPane[] => {
    const leaves: LeafPane[] = [];
    for (const tab of state.tabs) {
      forEachLeaf(getTabRoot(tab), (leaf) => leaves.push(leaf));
    }
    return leaves;
  };

  // A command-end mark briefly paints the tab ok/error so a quick glance
  // reveals how the last command finished, then settles back to idle.
  const COMPLETION_FLASH_MS: Record<"ok" | "error", number> = {
    ok: 900,
    error: 3000,
  };
  const completionTimers = new WeakMap<LeafPane, number>();

  const setLeafRunState = (leaf: LeafPane, state: PaneRunState): void => {
    leaf.runState = state;
    if (leaf.tab.activeLeaf === leaf) {
      setTabRunState(leaf.tab, state);
    }
  };

  const scheduleIdle = (leaf: LeafPane, delayMs: number): void => {
    const prev = completionTimers.get(leaf);
    if (prev !== undefined) {
      window.clearTimeout(prev);
    }
    const timer = window.setTimeout(() => {
      completionTimers.delete(leaf);
      if (leaf.mountState !== "disposed") {
        setLeafRunState(leaf, "idle");
      }
    }, delayMs);
    completionTimers.set(leaf, timer);
  };

  const focusLeaf = (
    leaf: LeafPane,
    options: { readonly focusTerminal?: boolean } = {},
  ): void => {
    const tab = leaf.tab;
    const root = getTabRoot(tab);

    state.activeTab = tab;
    tab.activeLeaf = leaf;

    forEachLeaf(root, (candidate) => {
      candidate.element.classList.toggle("active", candidate === leaf);
    });

    if (options.focusTerminal !== false && leaf.mountState === "ready" && leaf.sessionId) {
      leaf.terminal.focus();
    }

    updateTabLabel(tab);
    setTabRunState(tab, leaf.runState);
    setTabAgent(tab, leaf.agent);
  };

  const syncBroadcastState = (tab: Tab): void => {
    const root = getTabRoot(tab);

    tab.element.classList.toggle("broadcasting", tab.broadcastInput);
    forEachLeaf(root, (leaf) => {
      leaf.element.classList.toggle("broadcasting", tab.broadcastInput);
    });
  };

  const activateTab = (
    tab: Tab,
    options: { readonly focusTerminal?: boolean } = {},
  ): void => {
    const nextRoot = getTabRoot(tab);

    if (state.activeTab === tab) {
      const currentLeaf = tab.activeLeaf ?? findFirstLeaf(nextRoot);
      if (currentLeaf) {
        focusLeaf(currentLeaf, options);
      }
      return;
    }

    if (state.activeTab) {
      const activeRoot = getTabRoot(state.activeTab);
      state.activeTab.element.classList.remove("active");
      if (activeRoot.element.parentElement === elements.container) {
        elements.container.removeChild(activeRoot.element);
      }
    }

    elements.container.appendChild(nextRoot.element);
    tab.element.classList.add("active");
    state.activeTab = tab;

    forEachLeaf(nextRoot, fitLeafPane);

    const nextLeaf = tab.activeLeaf ?? findFirstLeaf(nextRoot);
    if (nextLeaf) {
      focusLeaf(nextLeaf, options);
    }
  };

  const createTab = (): Tab => {
    const id = `t${++state.nextTabId}`;
    const chrome = createTabElements(id);
    const tab: Tab = {
      id,
      ...chrome,
      root: null,
      activeLeaf: null,
      broadcastInput: false,
      customName: null,
      color: null,
    };

    const root = createLeafPane(tab, {
      fontSize: state.fontSize,
      onCwdChange: (leaf) => {
        if (leaf.tab.activeLeaf === leaf) {
          updateTabLabel(leaf.tab);
        }
      },
      onFocusRequested: (leaf) => {
        focusLeaf(leaf);
      },
    });
    tab.root = root;

    bindTabEvents(tab, {
      onActivate: () => activateTab(tab),
      onClose: () => {
        runAsync(() => closeTab(tab), "failed to close tab");
      },
      onRenameRequested: () => {
        startTabRename(tab, () => updateTabLabel(tab));
      },
      onReorder: (draggedId, beforeId) => reorderTab(draggedId, beforeId),
      onContextMenu: (anchor) => {
        openTabColorMenu(document, anchor, {
          onSelect: (key) => {
            tab.color = key;
            applyTabColor(tab, key);
          },
        });
      },
    });

    mountTab(tab, elements.tabStrip, elements.newTabButton);
    state.tabs.push(tab);
    updateTabLabel(tab);
    syncBroadcastState(tab);

    return tab;
  };

  const openNewTab = async (options: { readonly attachTo?: string; readonly initialCwd?: string } = {}): Promise<void> => {
    const tab = createTab();
    const root = getTabRoot(tab);

    if (options.initialCwd && root.type === "leaf") {
      root.cwd = options.initialCwd;
      updateTabLabel(tab);
    }

    activateTab(tab, { focusTerminal: false });

    if (root.type === "leaf") {
      await mountLeafPane(root, {
        leavesBySessionId: state.leavesBySessionId,
        getBroadcastTargets: () => listBroadcastTargets(tab),
        reportInvokeError,
        existingSessionId: options.attachTo,
      });
      focusLeaf(root);
    }
  };

  const closeTab = async (tab: Tab): Promise<void> => {
    const root = getTabRoot(tab);

    forEachLeaf(root, (leaf) => {
      disposeLeafPane(leaf, {
        leavesBySessionId: state.leavesBySessionId,
        reportInvokeError,
      });
    });

    const index = state.tabs.indexOf(tab);
    if (index >= 0) {
      state.tabs.splice(index, 1);
    }
    tab.element.remove();

    if (state.tabs.length === 0) {
      try {
        await getCurrentWindow().close();
      } catch (error) {
        reporter.report("failed to close the window", error, {
          level: "warn",
        });
      }
      return;
    }

    if (state.activeTab === tab) {
      if (root.element.parentElement === elements.container) {
        elements.container.removeChild(root.element);
      }
      state.activeTab = null;
      const neighbor = state.tabs[Math.max(0, Math.min(index, state.tabs.length - 1))];
      activateTab(neighbor);
    }
  };

  const reorderTab = (draggedId: string, beforeId: string | null): void => {
    const from = state.tabs.findIndex((t) => t.id === draggedId);
    if (from < 0) return;
    const [tab] = state.tabs.splice(from, 1);

    const targetIndex =
      beforeId === null
        ? state.tabs.length
        : state.tabs.findIndex((t) => t.id === beforeId);
    const to = targetIndex < 0 ? state.tabs.length : targetIndex;
    state.tabs.splice(to, 0, tab);

    const anchor = beforeId
      ? state.tabs.find((t) => t.id === beforeId)?.element ?? null
      : elements.newTabButton;
    elements.tabStrip.insertBefore(tab.element, anchor);
  };

  const listBroadcastTargets = (tab: Tab): LeafPane[] => {
    const leaves: LeafPane[] = [];
    forEachLeaf(getTabRoot(tab), (leaf) => leaves.push(leaf));
    return leaves;
  };

  const splitActive = async (direction: SplitDirection): Promise<void> => {
    const tab = state.activeTab;
    const activeLeaf = tab?.activeLeaf;
    if (!tab || !activeLeaf) {
      return;
    }

    const nextLeaf = createLeafPane(tab, {
      fontSize: state.fontSize,
      onCwdChange: (leaf) => {
        if (leaf.tab.activeLeaf === leaf) {
          updateTabLabel(leaf.tab);
        }
      },
      onFocusRequested: (leaf) => {
        focusLeaf(leaf);
      },
    });
    const split = createSplitPane(direction, activeLeaf, nextLeaf);

    replacePaneInTree(tab, activeLeaf, split, elements.container);
    syncBroadcastState(tab);

    await mountLeafPane(nextLeaf, {
      leavesBySessionId: state.leavesBySessionId,
      getBroadcastTargets: () => listBroadcastTargets(tab),
      reportInvokeError,
    });
    focusLeaf(nextLeaf);
  };

  const closeActivePane = async (): Promise<void> => {
    const tab = state.activeTab;
    const leaf = tab?.activeLeaf;
    if (!tab || !leaf) {
      return;
    }

    const parent = leaf.parent;
    tab.activeLeaf = null;

    disposeLeafPane(leaf, {
      leavesBySessionId: state.leavesBySessionId,
      reportInvokeError,
    });

    if (!parent) {
      await closeTab(tab);
      return;
    }

    const sibling = parent.a === leaf ? parent.b : parent.a;
    replacePaneInTree(tab, parent, sibling, elements.container);

    const nextLeaf = findFirstLeaf(sibling);
    if (nextLeaf) {
      focusLeaf(nextLeaf);
    } else {
      updateTabLabel(tab);
    }
  };

  const navigate = (direction: NavigationDirection): void => {
    const tab = state.activeTab;
    const activeLeaf = tab?.activeLeaf;
    if (!tab || !activeLeaf) {
      return;
    }

    const nextLeaf = findAdjacentLeaf(getTabRoot(tab), activeLeaf, direction);
    if (nextLeaf) {
      focusLeaf(nextLeaf);
    }
  };

  const cycleTab = (offset: number): void => {
    if (!state.activeTab || state.tabs.length === 0) {
      return;
    }

    const currentIndex = state.tabs.indexOf(state.activeTab);
    const nextTab =
      state.tabs[(currentIndex + offset + state.tabs.length) % state.tabs.length];
    activateTab(nextTab);
  };

  const toggleBroadcast = (): void => {
    if (!state.activeTab) {
      return;
    }

    state.activeTab.broadcastInput = !state.activeTab.broadcastInput;
    syncBroadcastState(state.activeTab);
  };

  const clearActive = (): void => {
    state.activeTab?.activeLeaf?.terminal.clear();
  };

  const addBookmark = (): void => {
    const leaf = state.activeTab?.activeLeaf;
    if (!leaf) return;
    const buffer = leaf.terminal.buffer.active;
    const line = buffer.viewportY;
    // Avoid duplicating a bookmark at the exact same line.
    if (leaf.bookmarks.some((b) => b.line === line)) return;
    const now = new Date();
    const label = `bookmark @ ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
    leaf.bookmarks.push({ line, label, createdAt: now.getTime() });
    if (leaf.bookmarks.length > 64) {
      leaf.bookmarks.splice(0, leaf.bookmarks.length - 64);
    }
  };

  const jumpToBookmark = (leaf: LeafPane, line: number): void => {
    if (state.activeTab !== leaf.tab) {
      activateTab(leaf.tab, { focusTerminal: false });
    }
    leaf.tab.activeLeaf = leaf;
    focusLeaf(leaf);
    leaf.terminal.scrollToLine(line);
  };

  const jumpToPrompt = (direction: "previous" | "next"): void => {
    const leaf = state.activeTab?.activeLeaf;
    if (!leaf || leaf.promptMarks.length === 0) {
      return;
    }
    const buffer = leaf.terminal.buffer.active;
    // Scroll position is the absolute line of the first row in the viewport.
    const current = buffer.viewportY;
    let target: number | undefined;
    if (direction === "previous") {
      for (let i = leaf.promptMarks.length - 1; i >= 0; i -= 1) {
        if (leaf.promptMarks[i] < current) {
          target = leaf.promptMarks[i];
          break;
        }
      }
    } else {
      for (const mark of leaf.promptMarks) {
        if (mark > current) {
          target = mark;
          break;
        }
      }
    }
    if (target === undefined) {
      return;
    }
    // xterm's scrollToLine is absolute and scrolls the target line to the top.
    leaf.terminal.scrollToLine(target);
  };

  // Cycle through panes whose agents are currently waiting for input. Walks
  // tabs in order, leaves within each tab in tree order, wraps around. The
  // pane we last jumped to is skipped on the next press so repeated presses
  // walk the fleet.
  let lastWaitingJumpTarget: LeafPane | null = null;

  const jumpToWaitingAgent = (): void => {
    const candidates: LeafPane[] = [];
    for (const tab of state.tabs) {
      forEachLeaf(getTabRoot(tab), (leaf) => {
        if (leaf.runState === "waiting") {
          candidates.push(leaf);
        }
      });
    }
    if (candidates.length === 0) {
      return;
    }
    let target: LeafPane | undefined;
    if (lastWaitingJumpTarget) {
      const lastIndex = candidates.indexOf(lastWaitingJumpTarget);
      if (lastIndex >= 0) {
        target = candidates[(lastIndex + 1) % candidates.length];
      }
    }
    if (!target) {
      target = candidates[0];
    }
    lastWaitingJumpTarget = target;
    const tab = target.tab;
    if (state.activeTab !== tab) {
      activateTab(tab, { focusTerminal: false });
    }
    tab.activeLeaf = target;
    focusLeaf(target);
  };

  const applyFontSize = (): void => {
    saveFontSize(window.localStorage, state.fontSize);
    for (const leaf of listLeaves()) {
      setLeafFontSize(leaf, state.fontSize);
    }
  };

  const bumpFontSize = (delta: number): void => {
    state.fontSize = clampFontSize(state.fontSize + delta);
    applyFontSize();
  };

  const resetFontSize = (): void => {
    state.fontSize = DEFAULT_FONT_SIZE;
    applyFontSize();
  };

  const activateTabByIndex = (index: number): void => {
    if (index < 0 || index >= state.tabs.length) {
      return;
    }
    activateTab(state.tabs[index]);
  };

  await onPtyOutput(({ sessionId, data }) => {
    const leaf = state.leavesBySessionId.get(sessionId);
    if (!leaf) {
      return;
    }
    leaf.terminal.write(outputDecoder.decode(new Uint8Array(data)));
  });

  await onPaneMark(({ sessionId, mark, exit }) => {
    const leaf = state.leavesBySessionId.get(sessionId);
    if (!leaf || leaf.mountState === "disposed") {
      return;
    }

    switch (mark) {
      case "A":
      case "B": {
        setLeafRunState(leaf, "idle");
        // Record the line number where this prompt starts so Cmd+↑ / Cmd+↓
        // can seek between prompts later. Line is 0-indexed absolute buffer
        // coordinate; xterm's buffer.active.cursorY + baseY maps to it.
        const buffer = leaf.terminal.buffer.active;
        const line = buffer.baseY + buffer.cursorY;
        const last = leaf.promptMarks[leaf.promptMarks.length - 1];
        if (last !== line) {
          leaf.promptMarks.push(line);
          // Keep the mark list from growing unbounded on noisy sessions.
          if (leaf.promptMarks.length > 4096) {
            leaf.promptMarks.splice(0, leaf.promptMarks.length - 4096);
          }
        }
        break;
      }
      case "C":
        setLeafRunState(leaf, "running");
        break;
      case "D": {
        const outcome: "ok" | "error" = exit === 0 || exit === null ? "ok" : "error";
        setLeafRunState(leaf, outcome);
        scheduleIdle(leaf, COMPLETION_FLASH_MS[outcome]);
        palette.refresh();

        // Notify on agent completion when the user is focused elsewhere.
        // Runs before the Agent(None) event arrives, so leaf.agent is still
        // populated.
        if (leaf.agent) {
          const tabLabel = leaf.tab.customName ?? leaf.tab.labelElement.textContent ?? leaf.tab.id;
          const verb = outcome === "ok" ? "finished" : `exited ${exit ?? "with error"}`;
          notifications.notifyBackground({
            title: `${leaf.agent} ${verb}`,
            body: `${tabLabel} · ${leaf.cwd}`,
          });
        }
        break;
      }
    }
  });

  const palette = createPanePalette(document, {
    listEntries: (): PalettePaneEntry[] => {
      const entries: PalettePaneEntry[] = [];
      for (const tab of state.tabs) {
        forEachLeaf(getTabRoot(tab), (leaf) => {
          entries.push({
            tabLabel: tab.customName ?? tab.labelElement.textContent ?? tab.id,
            cwd: leaf.cwd,
            agent: leaf.agent,
            runState: leaf.runState,
            leaf,
          });
        });
      }
      return entries;
    },
    onSelect: (leaf) => {
      const tab = leaf.tab;
      if (state.activeTab !== tab) {
        activateTab(tab, { focusTerminal: false });
      }
      tab.activeLeaf = leaf;
      focusLeaf(leaf);
    },
  });

  await onPaneStatus((event) => {
    const leaf = state.leavesBySessionId.get(event.sessionId);
    if (!leaf || leaf.mountState === "disposed") {
      return;
    }
    const normalized = normalizeStatusState(event.state);
    if (event.agent !== null) {
      leaf.agent = event.agent;
      if (leaf.tab.activeLeaf === leaf) {
        setTabAgent(leaf.tab, event.agent);
      }
    }
    setLeafRunState(leaf, normalized);
    if (normalized === "waiting") {
      const tabLabel =
        leaf.tab.customName ??
        leaf.tab.labelElement.textContent ??
        leaf.tab.id;
      notifications.notifyBackground({
        title: `${leaf.agent ?? "agent"} is waiting`,
        body: `${tabLabel} · ${leaf.cwd}`,
      });
    }
    palette.refresh();
  });

  await onPaneAgent(({ sessionId, agent }) => {
    const leaf = state.leavesBySessionId.get(sessionId);
    if (!leaf || leaf.mountState === "disposed") {
      return;
    }
    leaf.agent = agent;
    if (leaf.tab.activeLeaf === leaf) {
      setTabAgent(leaf.tab, agent);
    }
    palette.refresh();
  });

  await onPaneCwd(({ sessionId, cwd }) => {
    const leaf = state.leavesBySessionId.get(sessionId);
    if (!leaf) {
      return;
    }
    leaf.cwd = cwd;
    if (leaf.tab.activeLeaf === leaf) {
      updateTabLabel(leaf.tab);
    }
    palette.refresh();
  });

  await onPtyExit(({ sessionId }) => {
    const leaf = state.leavesBySessionId.get(sessionId);
    if (!leaf || leaf.mountState === "disposed") {
      return;
    }

    leaf.terminal.writeln("\r\n\x1b[90m[napkin] session exited\x1b[0m");

    window.setTimeout(() => {
      if (leaf.mountState === "disposed") {
        return;
      }

      const tab = leaf.tab;
      const parent = leaf.parent;
      tab.activeLeaf = null;

      disposeLeafPane(leaf, {
        leavesBySessionId: state.leavesBySessionId,
        reportInvokeError,
      });

      if (!parent) {
        runAsync(() => closeTab(tab), "failed to close exited tab");
        return;
      }

      const sibling = parent.a === leaf ? parent.b : parent.a;
      replacePaneInTree(tab, parent, sibling, elements.container);

      const nextLeaf = findFirstLeaf(sibling);
      if (!nextLeaf) {
        updateTabLabel(tab);
        return;
      }

      if (state.activeTab === tab) {
        focusLeaf(nextLeaf);
      } else {
        tab.activeLeaf = nextLeaf;
        updateTabLabel(tab);
      }
    }, 400);
  });

  elements.newTabButton.addEventListener("click", () => {
    runAsync(() => openNewTab(), "failed to open new tab");
  });

  registerKeybindings(window, {
    activateTabByIndex,
    bumpFontSize,
    clearActive,
    closeActivePane: () => {
      runAsync(() => closeActivePane(), "failed to close pane");
    },
    cycleTab,
    navigate,
    openNewTab: () => {
      runAsync(() => openNewTab(), "failed to open new tab");
    },
    resetFontSize,
    splitActive: (direction) => {
      runAsync(() => splitActive(direction), "failed to split pane");
    },
    toggleAgentPalette: () => palette.toggle("agents"),
    togglePanePalette: () => palette.toggle("all"),
    toggleBroadcast,
    toggleSearch: () => search.toggle(),
    findNextInPane: () => search.findNext(),
    findPreviousInPane: () => search.findPrevious(),
    toggleHelp: () => help.toggle(),
    toggleCommandPalette: () => commandPalette.toggle(),
    jumpToWaitingAgent,
    jumpToPrompt,
    addBookmark,
  });

  window.addEventListener("resize", () => {
    if (!state.activeTab) {
      return;
    }
    forEachLeaf(getTabRoot(state.activeTab), fitLeafPane);
  });

  let existing: Awaited<ReturnType<typeof listPtySessions>> = [];
  try {
    existing = await listPtySessions();
  } catch (error) {
    reporter.report("failed to list sessions", error, { level: "warn" });
  }

  if (existing.length === 0) {
    await openNewTab();
  } else {
    // Reattach each existing daemon session as its own tab. First tab ends up
    // focused; ordering follows whatever the daemon reported.
    for (const summary of existing) {
      await openNewTab({
        attachTo: summary.sessionId,
        initialCwd: summary.cwd,
      });
    }
  }
}
