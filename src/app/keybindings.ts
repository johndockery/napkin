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
  readonly toggleHistorySearch: () => void;
  readonly findNextInPane: () => void;
  readonly findPreviousInPane: () => void;
  readonly toggleHelp: () => void;
  readonly toggleCommandPalette: () => void;
  readonly jumpToWaitingAgent: () => void;
  readonly jumpToPrompt: (direction: "previous" | "next") => void;
  readonly addBookmark: () => void;
  readonly toggleWriteLock: () => void;
}

export type ActionName =
  | "new_tab"
  | "close_pane"
  | "split_horizontal"
  | "split_vertical"
  | "clear_pane"
  | "broadcast"
  | "agent_palette"
  | "pane_palette"
  | "command_palette"
  | "find"
  | "history"
  | "find_next"
  | "find_previous"
  | "toggle_help"
  | "jump_to_waiting_agent"
  | "jump_prompt_previous"
  | "jump_prompt_next"
  | "add_bookmark"
  | "write_lock"
  | "font_bigger"
  | "font_smaller"
  | "font_reset"
  | "navigate_left"
  | "navigate_right"
  | "navigate_up"
  | "navigate_down"
  | "previous_tab"
  | "next_tab";

interface ParsedBinding {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Normalized key, lowercase. "=" / "+" treated as the same physical key. */
  readonly key: string;
}

// Default shortcut for each action. Users override by setting the same
// action name in [keybindings].
const DEFAULT_BINDINGS: Record<ActionName, string> = {
  new_tab: "Cmd+T",
  close_pane: "Cmd+W",
  split_horizontal: "Cmd+D",
  split_vertical: "Cmd+Shift+D",
  clear_pane: "Cmd+K",
  broadcast: "Cmd+Shift+B",
  agent_palette: "Cmd+Shift+A",
  pane_palette: "Cmd+P",
  command_palette: "Cmd+Shift+P",
  find: "Cmd+F",
  history: "Cmd+Shift+F",
  find_next: "Cmd+G",
  find_previous: "Cmd+Shift+G",
  toggle_help: "Cmd+/",
  jump_to_waiting_agent: "Cmd+J",
  jump_prompt_previous: "Cmd+ArrowUp",
  jump_prompt_next: "Cmd+ArrowDown",
  add_bookmark: "Cmd+Shift+M",
  write_lock: "Cmd+Shift+L",
  font_bigger: "Cmd+=",
  font_smaller: "Cmd+-",
  font_reset: "Cmd+0",
  navigate_left: "Cmd+Shift+ArrowLeft",
  navigate_right: "Cmd+Shift+ArrowRight",
  navigate_up: "Cmd+Shift+ArrowUp",
  navigate_down: "Cmd+Shift+ArrowDown",
  previous_tab: "Cmd+Shift+[",
  next_tab: "Cmd+Shift+]",
};

export function registerKeybindings(
  win: Window,
  handlers: KeybindingHandlers,
  overrides: Readonly<Record<string, string>> = {},
): () => void {
  const resolved = resolveBindings(overrides);

  const run = (action: ActionName): boolean => {
    switch (action) {
      case "new_tab": handlers.openNewTab(); return true;
      case "close_pane": handlers.closeActivePane(); return true;
      case "split_horizontal": handlers.splitActive("horizontal"); return true;
      case "split_vertical": handlers.splitActive("vertical"); return true;
      case "clear_pane": handlers.clearActive(); return true;
      case "broadcast": handlers.toggleBroadcast(); return true;
      case "agent_palette": handlers.toggleAgentPalette(); return true;
      case "pane_palette": handlers.togglePanePalette(); return true;
      case "command_palette": handlers.toggleCommandPalette(); return true;
      case "find": handlers.toggleSearch(); return true;
      case "history": handlers.toggleHistorySearch(); return true;
      case "find_next": handlers.findNextInPane(); return true;
      case "find_previous": handlers.findPreviousInPane(); return true;
      case "toggle_help": handlers.toggleHelp(); return true;
      case "jump_to_waiting_agent": handlers.jumpToWaitingAgent(); return true;
      case "jump_prompt_previous": handlers.jumpToPrompt("previous"); return true;
      case "jump_prompt_next": handlers.jumpToPrompt("next"); return true;
      case "add_bookmark": handlers.addBookmark(); return true;
      case "write_lock": handlers.toggleWriteLock(); return true;
      case "font_bigger": handlers.bumpFontSize(1); return true;
      case "font_smaller": handlers.bumpFontSize(-1); return true;
      case "font_reset": handlers.resetFontSize(); return true;
      case "navigate_left": handlers.navigate("left"); return true;
      case "navigate_right": handlers.navigate("right"); return true;
      case "navigate_up": handlers.navigate("up"); return true;
      case "navigate_down": handlers.navigate("down"); return true;
      case "previous_tab": handlers.cycleTab(-1); return true;
      case "next_tab": handlers.cycleTab(1); return true;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Cmd+digit switches to tab N. Not configurable — too baked into muscle
    // memory to be worth exposing.
    if (event.metaKey && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      if (/^[1-9]$/.test(event.key)) {
        handlers.activateTabByIndex(Number.parseInt(event.key, 10) - 1);
        event.preventDefault();
        return;
      }
    }

    for (const [action, binding] of resolved) {
      if (matches(binding, event)) {
        if (run(action)) {
          event.preventDefault();
        }
        return;
      }
    }
  };

  win.addEventListener("keydown", onKeyDown, true);

  return () => {
    win.removeEventListener("keydown", onKeyDown, true);
  };
}

function resolveBindings(
  overrides: Readonly<Record<string, string>>,
): ReadonlyArray<readonly [ActionName, ParsedBinding]> {
  const out: Array<readonly [ActionName, ParsedBinding]> = [];
  for (const [action, def] of Object.entries(DEFAULT_BINDINGS) as Array<
    [ActionName, string]
  >) {
    const raw = overrides[action] ?? def;
    if (raw === "") continue; // explicit disable
    const parsed = parseBinding(raw);
    if (!parsed) {
      console.warn(`napkin: could not parse keybinding "${raw}" for ${action}`);
      continue;
    }
    out.push([action, parsed]);
  }
  return out;
}

function parseBinding(raw: string): ParsedBinding | null {
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    const lc = part.toLowerCase();
    if (lc === "cmd" || lc === "meta" || lc === "super") meta = true;
    else if (lc === "ctrl" || lc === "control") ctrl = true;
    else if (lc === "alt" || lc === "option" || lc === "opt") alt = true;
    else if (lc === "shift") shift = true;
    else key = normalizeKey(part);
  }
  if (!key) return null;
  return { meta, ctrl, alt, shift, key };
}

function normalizeKey(key: string): string {
  const lc = key.toLowerCase();
  // Common aliases
  if (lc === "esc") return "escape";
  if (lc === "return") return "enter";
  if (lc === "space") return " ";
  if (lc === "plus") return "=";
  if (lc === "minus") return "-";
  if (lc === "up") return "arrowup";
  if (lc === "down") return "arrowdown";
  if (lc === "left") return "arrowleft";
  if (lc === "right") return "arrowright";
  return lc;
}

function matches(binding: ParsedBinding, event: KeyboardEvent): boolean {
  if (binding.meta !== event.metaKey) return false;
  if (binding.ctrl !== event.ctrlKey) return false;
  if (binding.alt !== event.altKey) return false;
  if (binding.shift !== event.shiftKey) return false;
  const pressed = event.key.toLowerCase();
  if (pressed === binding.key) return true;
  // Treat "=" and "+" as the same physical key so Cmd+= and Cmd++ both hit
  // the "font_bigger" binding regardless of keyboard layout.
  if ((binding.key === "=" || binding.key === "+") && (pressed === "=" || pressed === "+")) {
    return true;
  }
  if ((binding.key === "-" || binding.key === "_") && (pressed === "-" || pressed === "_")) {
    return true;
  }
  if ((binding.key === "[" || binding.key === "{") && (pressed === "[" || pressed === "{")) {
    return true;
  }
  if ((binding.key === "]" || binding.key === "}") && (pressed === "]" || pressed === "}")) {
    return true;
  }
  return false;
}
