import type { ITheme, ITerminalOptions } from "@xterm/xterm";

const FONT_SIZE_STORAGE_KEY = "napkin:fontSize";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;

const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "SF Mono", Menlo, monospace';

const DEFAULT_THEME: ITheme = {
  background: "rgba(0,0,0,0)",
  foreground: "#e6e6e6",
  cursor: "#fefbf4",
  cursorAccent: "#0b0c0f",
  selectionBackground: "rgba(254, 251, 244, 0.22)",
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
};

// snake_case config keys → xterm camelCase theme keys.
const THEME_KEY_MAP: Record<string, keyof ITheme> = {
  background: "background",
  foreground: "foreground",
  cursor: "cursor",
  cursor_accent: "cursorAccent",
  selection_background: "selectionBackground",
  selection_foreground: "selectionForeground",
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  bright_black: "brightBlack",
  bright_red: "brightRed",
  bright_green: "brightGreen",
  bright_yellow: "brightYellow",
  bright_blue: "brightBlue",
  bright_magenta: "brightMagenta",
  bright_cyan: "brightCyan",
  bright_white: "brightWhite",
};

export type CursorStyle = "block" | "bar" | "underline";
export type BellStyle = "none" | "visual" | "sound";
export type TabColorKey = "red" | "amber" | "green" | "teal" | "blue" | "purple" | "pink";
export type AgentNotifyState = "working" | "waiting" | "done" | "error" | "idle";

export interface ShellConfig {
  readonly program: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
}

export interface WindowConfig {
  readonly opacity: number;
  readonly blur: boolean;
  readonly padding: number;
}

export interface TerminalConfig {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly letterSpacing: number;
  readonly cursorStyle: CursorStyle;
  readonly cursorBlink: boolean;
  readonly scrollback: number;
  readonly bell: BellStyle;
  readonly copyOnSelect: boolean;
  readonly theme: ITheme;
}

export interface TabsConfig {
  readonly colorByCommand: Readonly<Record<string, TabColorKey>>;
}

export interface AgentsConfig {
  readonly detect: boolean;
  readonly notifyOn: ReadonlySet<AgentNotifyState>;
  readonly costBudgetUsd: number;
}

export interface IntegrationsConfig {
  readonly editor: string | null;
  readonly diffTool: string | null;
}

export interface ResolvedConfig {
  readonly shell: ShellConfig;
  readonly window: WindowConfig;
  readonly terminal: TerminalConfig;
  readonly tabs: TabsConfig;
  readonly agents: AgentsConfig;
  readonly keybindings: Readonly<Record<string, string>>;
  readonly integrations: IntegrationsConfig;
  /** Legacy shim for existing call sites. */
  readonly fontFamily: string;
  readonly theme: ITheme;
  readonly initialFontSize: number;
}

export let TERMINAL_FONT_FAMILY: string = DEFAULT_FONT_FAMILY;
export let TERMINAL_THEME: ITheme = { ...DEFAULT_THEME };
export let TERMINAL_OPTIONS: ITerminalOptions = defaultTerminalOptions();

function defaultTerminalOptions(): ITerminalOptions {
  return {
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    lineHeight: 1.35,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorWidth: 2,
    scrollback: 10_000,
    // smoothScrollDuration applies to wheel events too. With trackpads
    // firing wheel events every ~16ms, an 80ms animation queues up faster
    // than it can play and feels laggy — especially under heavy agent
    // output. 0 disables the animation; native scrolling feels snappier.
    smoothScrollDuration: 0,
    allowTransparency: true,
    theme: { ...DEFAULT_THEME },
  };
}

/**
 * Merge defaults with a user config object and apply side effects:
 * updates module-level exports and CSS variables the chrome depends on.
 * Safe to call with {} when no config file exists.
 */
export function applyConfig(raw: unknown): ResolvedConfig {
  const source = readObject(raw);

  const shell = readShell(readObject(source.shell));
  const windowCfg = readWindow(readObject(source.window));
  const terminal = readTerminal(readObject(source.terminal));
  const tabs = readTabs(readObject(source.tabs));
  const agents = readAgents(readObject(source.agents));
  const keybindings = readKeybindings(readObject(source.keybindings));
  const integrations = readIntegrations(readObject(source.integrations));

  TERMINAL_FONT_FAMILY = terminal.fontFamily;
  TERMINAL_THEME = terminal.theme;
  TERMINAL_OPTIONS = {
    fontFamily: terminal.fontFamily,
    fontSize: terminal.fontSize,
    lineHeight: terminal.lineHeight,
    letterSpacing: terminal.letterSpacing,
    cursorBlink: terminal.cursorBlink,
    cursorStyle: terminal.cursorStyle,
    cursorWidth: 2,
    scrollback: terminal.scrollback,
    smoothScrollDuration: 0,
    allowTransparency: true,
    theme: terminal.theme,
  };

  applyCssVariables(windowCfg, terminal);

  return {
    shell,
    window: windowCfg,
    terminal,
    tabs,
    agents,
    keybindings,
    integrations,
    fontFamily: terminal.fontFamily,
    theme: terminal.theme,
    initialFontSize: clampFontSize(terminal.fontSize),
  };
}

function applyCssVariables(win: WindowConfig, term: TerminalConfig): void {
  const root = document.documentElement;
  root.style.setProperty("--window-opacity", String(win.opacity));
  root.style.setProperty("--pane-padding", `${win.padding}px`);
  root.style.setProperty("--chrome-backdrop-filter", win.blur ? "blur(12px)" : "none");
  root.style.setProperty(
    "--terminal-bg",
    typeof term.theme.background === "string" ? term.theme.background : "transparent",
  );
}

function readShell(obj: Record<string, unknown>): ShellConfig {
  return {
    program: stringOrNull(obj.program),
    args: readStringArray(obj.args),
    env: readStringRecord(obj.env),
    cwd: stringOrNull(obj.cwd),
  };
}

function readWindow(obj: Record<string, unknown>): WindowConfig {
  return {
    opacity: clamp01(numberOr(obj.opacity, 1)),
    blur: boolOr(obj.blur, true),
    padding: Math.max(0, Math.trunc(numberOr(obj.padding, 8))),
  };
}

function readTerminal(obj: Record<string, unknown>): TerminalConfig {
  const rawTheme = readObject(obj.theme);
  const theme: ITheme = { ...DEFAULT_THEME };
  for (const [tomlKey, xtermKey] of Object.entries(THEME_KEY_MAP)) {
    const value = rawTheme[tomlKey];
    if (typeof value === "string" && value.length > 0) {
      (theme as Record<string, string>)[xtermKey] = value;
    }
  }

  return {
    fontFamily: stringOr(obj.font_family, DEFAULT_FONT_FAMILY),
    fontSize: clampFontSize(numberOr(obj.font_size, DEFAULT_FONT_SIZE)),
    lineHeight: clamp(numberOr(obj.line_height, 1.35), 0.8, 3),
    letterSpacing: clamp(numberOr(obj.letter_spacing, 0), -2, 2),
    cursorStyle: parseCursorStyle(obj.cursor_style),
    cursorBlink: boolOr(obj.cursor_blink, true),
    scrollback: Math.max(0, Math.trunc(numberOr(obj.scrollback, 10_000))),
    bell: parseBellStyle(obj.bell),
    copyOnSelect: boolOr(obj.copy_on_select, false),
    theme,
  };
}

function readTabs(obj: Record<string, unknown>): TabsConfig {
  const rawMap = readObject(obj.color_by_command);
  const colorByCommand: Record<string, TabColorKey> = {};
  const allowed: TabColorKey[] = ["red", "amber", "green", "teal", "blue", "purple", "pink"];
  for (const [cmd, color] of Object.entries(rawMap)) {
    if (typeof color !== "string") continue;
    const lc = color.toLowerCase() as TabColorKey;
    if (allowed.includes(lc)) {
      colorByCommand[cmd.toLowerCase()] = lc;
    }
  }
  return { colorByCommand };
}

function readAgents(obj: Record<string, unknown>): AgentsConfig {
  const states: AgentNotifyState[] = ["working", "waiting", "done", "error", "idle"];
  const notifyOn = new Set<AgentNotifyState>();
  if (Array.isArray(obj.notify_on)) {
    for (const entry of obj.notify_on) {
      if (typeof entry === "string") {
        const lc = entry.toLowerCase() as AgentNotifyState;
        if (states.includes(lc)) notifyOn.add(lc);
      }
    }
  } else {
    notifyOn.add("waiting");
    notifyOn.add("error");
  }
  return {
    detect: boolOr(obj.detect, true),
    notifyOn,
    costBudgetUsd: Math.max(0, numberOr(obj.cost_budget_usd, 0)),
  };
}

function readKeybindings(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = v;
    }
  }
  return out;
}

function readIntegrations(obj: Record<string, unknown>): IntegrationsConfig {
  return {
    editor: stringOrNull(obj.editor),
    diffTool: stringOrNull(obj.diff_tool),
  };
}

function parseCursorStyle(v: unknown): CursorStyle {
  if (typeof v === "string") {
    const lc = v.toLowerCase();
    if (lc === "block" || lc === "bar" || lc === "underline") return lc;
  }
  return "bar";
}

function parseBellStyle(v: unknown): BellStyle {
  if (typeof v === "string") {
    const lc = v.toLowerCase();
    if (lc === "none" || lc === "visual" || lc === "sound") return lc;
  }
  return "none";
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function readStringRecord(value: unknown): Record<string, string> {
  const obj = readObject(value);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function clampFontSize(fontSize: number): number {
  const nextFontSize = Number.isFinite(fontSize)
    ? Math.trunc(fontSize)
    : DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextFontSize));
}

export function loadFontSize(storage: Storage): number {
  const stored = storage.getItem(FONT_SIZE_STORAGE_KEY);
  if (stored === null) {
    return DEFAULT_FONT_SIZE;
  }
  const parsed = Number.parseInt(stored, 10);
  return clampFontSize(Number.isFinite(parsed) ? parsed : DEFAULT_FONT_SIZE);
}

export function saveFontSize(storage: Storage, fontSize: number): void {
  storage.setItem(FONT_SIZE_STORAGE_KEY, String(clampFontSize(fontSize)));
}
