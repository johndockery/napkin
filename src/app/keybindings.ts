import type { NavigationDirection, SplitDirection } from "./types.ts";

export interface KeybindingHandlers {
  readonly activateTabByIndex: (index: number) => void;
  readonly bumpFontSize: (delta: number) => void;
  readonly clearActive: () => void;
  readonly closeActivePane: () => void;
  readonly cycleTab: (offset: number) => void;
  readonly navigate: (direction: NavigationDirection) => void;
  readonly openNewTab: () => void;
  readonly resetFontSize: () => void;
  readonly splitActive: (direction: SplitDirection) => void;
  readonly toggleAgentPalette: () => void;
  readonly togglePanePalette: () => void;
  readonly toggleBroadcast: () => void;
  readonly toggleSearch: () => void;
  readonly findNextInPane: () => void;
  readonly findPreviousInPane: () => void;
}

export function registerKeybindings(
  win: Window,
  handlers: KeybindingHandlers,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.metaKey) {
      return;
    }

    const key = event.key.toLowerCase();

    if (key === "t" && !event.shiftKey) {
      handlers.openNewTab();
      event.preventDefault();
      return;
    }
    if (key === "d" && !event.shiftKey) {
      handlers.splitActive("horizontal");
      event.preventDefault();
      return;
    }
    if (key === "d" && event.shiftKey) {
      handlers.splitActive("vertical");
      event.preventDefault();
      return;
    }
    if (key === "w" && !event.shiftKey) {
      handlers.closeActivePane();
      event.preventDefault();
      return;
    }
    if (key === "k" && !event.shiftKey) {
      handlers.clearActive();
      event.preventDefault();
      return;
    }
    if (key === "b" && event.shiftKey) {
      handlers.toggleBroadcast();
      event.preventDefault();
      return;
    }
    if (key === "a" && event.shiftKey) {
      handlers.toggleAgentPalette();
      event.preventDefault();
      return;
    }
    if (key === "p" && !event.shiftKey) {
      handlers.togglePanePalette();
      event.preventDefault();
      return;
    }
    if (key === "f" && !event.shiftKey) {
      handlers.toggleSearch();
      event.preventDefault();
      return;
    }
    if (key === "g" && !event.shiftKey) {
      handlers.findNextInPane();
      event.preventDefault();
      return;
    }
    if (key === "g" && event.shiftKey) {
      handlers.findPreviousInPane();
      event.preventDefault();
      return;
    }

    if (!event.shiftKey && (key === "=" || key === "+")) {
      handlers.bumpFontSize(1);
      event.preventDefault();
      return;
    }
    if (!event.shiftKey && (key === "-" || key === "_")) {
      handlers.bumpFontSize(-1);
      event.preventDefault();
      return;
    }
    if (!event.shiftKey && key === "0") {
      handlers.resetFontSize();
      event.preventDefault();
      return;
    }

    if (event.shiftKey) {
      if (key === "arrowleft") {
        handlers.navigate("left");
        event.preventDefault();
        return;
      }
      if (key === "arrowright") {
        handlers.navigate("right");
        event.preventDefault();
        return;
      }
      if (key === "arrowup") {
        handlers.navigate("up");
        event.preventDefault();
        return;
      }
      if (key === "arrowdown") {
        handlers.navigate("down");
        event.preventDefault();
        return;
      }
      if (key === "[" || key === "{") {
        handlers.cycleTab(-1);
        event.preventDefault();
        return;
      }
      if (key === "]" || key === "}") {
        handlers.cycleTab(1);
        event.preventDefault();
      }
    }

    if (!event.shiftKey && /^[1-9]$/.test(key)) {
      handlers.activateTabByIndex(Number.parseInt(key, 10) - 1);
      event.preventDefault();
    }
  };

  win.addEventListener("keydown", onKeyDown, true);

  return () => {
    win.removeEventListener("keydown", onKeyDown, true);
  };
}
