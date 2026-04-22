import { getCurrentWindow } from "@tauri-apps/api/window";

import type { ErrorReporter } from "./errors.ts";
import { onPaneCwd, onPaneMark, onPtyExit, onPtyOutput } from "./ipc.ts";
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
  setTabRunState,
  startTabRename,
  updateTabLabel,
} from "./tabs.ts";
import {
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

export async function bootWorkspace(
  elements: AppElements,
  reporter: ErrorReporter,
): Promise<void> {
  const state: AppState = {
    elements,
    leavesBySessionId: new Map<string, LeafPane>(),
    tabs: [],
    activeTab: null,
    nextTabId: 0,
    fontSize: loadFontSize(window.localStorage),
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
    });

    mountTab(tab, elements.tabStrip, elements.newTabButton);
    state.tabs.push(tab);
    updateTabLabel(tab);
    syncBroadcastState(tab);

    return tab;
  };

  const openNewTab = async (): Promise<void> => {
    const tab = createTab();
    const root = getTabRoot(tab);

    activateTab(tab, { focusTerminal: false });

    if (root.type === "leaf") {
      await mountLeafPane(root, {
        leavesBySessionId: state.leavesBySessionId,
        getBroadcastTargets: () => listBroadcastTargets(tab),
        reportInvokeError,
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
      case "B":
        setLeafRunState(leaf, "idle");
        break;
      case "C":
        setLeafRunState(leaf, "running");
        break;
      case "D": {
        const outcome: "ok" | "error" = exit === 0 || exit === null ? "ok" : "error";
        setLeafRunState(leaf, outcome);
        scheduleIdle(leaf, COMPLETION_FLASH_MS[outcome]);
        break;
      }
    }
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
    toggleBroadcast,
  });

  window.addEventListener("resize", () => {
    if (!state.activeTab) {
      return;
    }
    forEachLeaf(getTabRoot(state.activeTab), fitLeafPane);
  });

  await openNewTab();
}
