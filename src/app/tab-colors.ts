//! A small palette of tab tint colours picked so they read at the cream
//! accent level without competing with the run-state dot.

import type { Tab } from "./types.ts";

export interface TabColor {
  readonly key: string;
  readonly name: string;
  readonly hex: string;
}

export const TAB_COLORS: readonly TabColor[] = [
  { key: "red", name: "Red", hex: "#b82b23" },
  { key: "amber", name: "Amber", hex: "#e5c07b" },
  { key: "green", name: "Green", hex: "#98c379" },
  { key: "teal", name: "Teal", hex: "#56b6c2" },
  { key: "blue", name: "Blue", hex: "#61afef" },
  { key: "purple", name: "Purple", hex: "#c678dd" },
  { key: "pink", name: "Pink", hex: "#e06c75" },
] as const;

export const TAB_COLOR_KEYS = new Set(TAB_COLORS.map((c) => c.key));

export function applyTabColor(tab: Tab, key: string | null): void {
  if (key === null) {
    delete tab.element.dataset.color;
    return;
  }
  if (!TAB_COLOR_KEYS.has(key)) {
    return;
  }
  tab.element.dataset.color = key;
}

export interface TabColorMenuOptions {
  readonly onSelect: (key: string | null) => void;
}

/**
 * Open a small color-picker popover anchored to a tab. Auto-closes on
 * outside click or selection.
 */
export function openTabColorMenu(
  doc: Document,
  anchor: HTMLElement,
  options: TabColorMenuOptions,
): void {
  const existing = doc.querySelector(".napkin-tab-color-menu");
  existing?.remove();

  const menu = doc.createElement("div");
  menu.className = "napkin-tab-color-menu";
  menu.setAttribute("role", "menu");

  for (const color of TAB_COLORS) {
    const swatch = doc.createElement("button");
    swatch.type = "button";
    swatch.className = "napkin-tab-swatch";
    swatch.title = color.name;
    swatch.style.background = color.hex;
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      options.onSelect(color.key);
    });
    menu.appendChild(swatch);
  }

  const clearBtn = doc.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "napkin-tab-swatch napkin-tab-swatch-clear";
  clearBtn.title = "Clear color";
  clearBtn.textContent = "×";
  clearBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
    options.onSelect(null);
  });
  menu.appendChild(clearBtn);

  doc.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  const onDocMouseDown = (event: MouseEvent) => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  };
  const onDocKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };

  const close = () => {
    menu.remove();
    doc.removeEventListener("mousedown", onDocMouseDown, true);
    doc.removeEventListener("keydown", onDocKey, true);
  };

  queueMicrotask(() => {
    doc.addEventListener("mousedown", onDocMouseDown, true);
    doc.addEventListener("keydown", onDocKey, true);
  });
}
