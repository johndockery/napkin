const FONT_SIZE_STORAGE_KEY = "napkin:fontSize";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 28;
export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "SF Mono", Menlo, monospace';

export const TERMINAL_THEME = {
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
} as const;

export function clampFontSize(fontSize: number): number {
  const nextFontSize = Number.isFinite(fontSize)
    ? Math.trunc(fontSize)
    : DEFAULT_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, nextFontSize));
}

export function loadFontSize(storage: Storage): number {
  const storedFontSize = Number.parseInt(
    storage.getItem(FONT_SIZE_STORAGE_KEY) ?? String(DEFAULT_FONT_SIZE),
    10,
  );
  return clampFontSize(storedFontSize);
}

export function saveFontSize(storage: Storage, fontSize: number): void {
  storage.setItem(FONT_SIZE_STORAGE_KEY, String(clampFontSize(fontSize)));
}
