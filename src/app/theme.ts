import type { ITheme } from "@xterm/xterm";

const FONT_SIZE_STORAGE_KEY = "napkin:fontSize";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;

const DEFAULT_FONT_FAMILY = '"JetBrains Mono", "SF Mono", Menlo, monospace';

const DEFAULT_THEME = {
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
} as const;

export let TERMINAL_FONT_FAMILY: string = DEFAULT_FONT_FAMILY;
export let TERMINAL_THEME: ITheme = { ...DEFAULT_THEME };

export interface ResolvedConfig {
  readonly fontFamily: string;
  readonly theme: ITheme;
  readonly initialFontSize: number;
}

/**
 * Merge defaults with a user config object (any shape; unknown fields are
 * ignored). Safe to call with {} when no config file exists.
 */
export function applyConfig(raw: unknown): ResolvedConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const terminal = readObject(source.terminal);
  const rawTheme = readObject(terminal.theme);

  const fontFamily = stringOr(terminal.font_family, DEFAULT_FONT_FAMILY);
  const theme: ITheme = { ...DEFAULT_THEME };
  for (const key of Object.keys(rawTheme)) {
    const value = rawTheme[key];
    if (typeof value === "string") {
      (theme as Record<string, string>)[key] = value;
    }
  }

  TERMINAL_FONT_FAMILY = fontFamily;
  TERMINAL_THEME = theme;

  const initialFontSize = clampFontSize(
    numberOr(terminal.font_size, DEFAULT_FONT_SIZE),
  );

  return { fontFamily, theme, initialFontSize };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
