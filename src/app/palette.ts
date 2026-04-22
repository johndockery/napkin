//! Pane palette: an overlay listing panes in the workspace with optional
//! filtering and fuzzy search. Used by two shortcuts:
//!
//!   Cmd+P        — all panes, filterable by query
//!   Cmd+Shift+A  — panes with a running agent only

import type { LeafPane, PaneRunState } from "./types.ts";

export interface PalettePaneEntry {
  readonly tabLabel: string;
  readonly cwd: string;
  readonly agent: string | null;
  readonly runState: PaneRunState;
  readonly leaf: LeafPane;
}

export type PaletteMode = "all" | "agents";

export interface PanePalette {
  open(mode: PaletteMode): void;
  toggle(mode: PaletteMode): void;
  close(): void;
  refresh(): void;
}

export interface PanePaletteOptions {
  readonly listEntries: () => PalettePaneEntry[];
  readonly onSelect: (leaf: LeafPane) => void;
}

const EMPTY_MESSAGES: Record<PaletteMode, string> = {
  all: "No panes open.",
  agents: "No agents running.",
};

const HEADER_LABELS: Record<PaletteMode, string> = {
  all: "Panes",
  agents: "Active agents",
};

export function createPanePalette(
  doc: Document,
  options: PanePaletteOptions,
): PanePalette {
  const root = doc.createElement("div");
  root.className = "napkin-palette";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-palette-backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  const frame = doc.createElement("div");
  frame.className = "napkin-palette-frame";

  const header = doc.createElement("div");
  header.className = "napkin-palette-header";

  const input = doc.createElement("input");
  input.className = "napkin-palette-input";
  input.type = "text";
  input.placeholder = "Type to filter…";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.addEventListener("input", () => {
    query = input.value.trim().toLowerCase();
    selectedIndex = 0;
    render();
  });

  const list = doc.createElement("ul");
  list.className = "napkin-palette-list";

  const empty = doc.createElement("div");
  empty.className = "napkin-palette-empty";

  const hint = doc.createElement("div");
  hint.className = "napkin-palette-hint";
  hint.textContent = "↑↓ to move · Enter to jump · Esc to close";

  frame.append(header, input, list, empty, hint);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  let mode: PaletteMode = "all";
  let query = "";
  let entries: PalettePaneEntry[] = [];
  let selectedIndex = 0;

  const matchesMode = (entry: PalettePaneEntry): boolean =>
    mode === "all" ? true : entry.agent !== null;

  const matchesQuery = (entry: PalettePaneEntry): boolean => {
    if (query === "") return true;
    const haystack = `${entry.tabLabel} ${entry.cwd} ${entry.agent ?? ""}`.toLowerCase();
    return haystack.includes(query);
  };

  const render = () => {
    const raw = options.listEntries().filter(matchesMode).filter(matchesQuery);
    // Agents first, then everything else; preserve tab order within groups.
    entries = [...raw].sort((a, b) => {
      if ((a.agent ? 0 : 1) !== (b.agent ? 0 : 1)) {
        return a.agent ? -1 : 1;
      }
      return 0;
    });

    list.replaceChildren();
    if (entries.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      empty.textContent = query === "" ? EMPTY_MESSAGES[mode] : `No matches for "${query}".`;
      selectedIndex = 0;
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    selectedIndex = Math.min(selectedIndex, entries.length - 1);

    entries.forEach((entry, index) => {
      const item = doc.createElement("li");
      item.className = "napkin-palette-item";
      item.dataset.index = String(index);
      if (index === selectedIndex) {
        item.dataset.active = "true";
      }

      const dot = doc.createElement("span");
      dot.className = "napkin-palette-dot tab-status";
      dot.dataset.state = entry.runState;

      if (entry.agent) {
        const badge = doc.createElement("span");
        badge.className = "napkin-palette-agent tab-agent";
        badge.dataset.agent = entry.agent;
        badge.textContent = entry.agent;
        item.append(dot, badge);
      } else {
        item.append(dot);
      }

      const label = doc.createElement("span");
      label.className = "napkin-palette-label";
      label.textContent = entry.tabLabel;

      const path = doc.createElement("span");
      path.className = "napkin-palette-cwd";
      path.textContent = entry.cwd;

      item.append(label, path);
      item.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelection();
      });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        selectedIndex = index;
        activateSelected();
      });

      list.appendChild(item);
    });
  };

  const updateSelection = () => {
    const items = list.querySelectorAll<HTMLElement>(".napkin-palette-item");
    items.forEach((item, index) => {
      if (index === selectedIndex) {
        item.dataset.active = "true";
        item.scrollIntoView({ block: "nearest" });
      } else {
        delete item.dataset.active;
      }
    });
  };

  const activateSelected = () => {
    const entry = entries[selectedIndex];
    if (!entry) return;
    close();
    options.onSelect(entry.leaf);
  };

  const open = (nextMode: PaletteMode) => {
    const reopening = !root.hidden;
    mode = nextMode;
    header.textContent = HEADER_LABELS[mode];
    if (!reopening) {
      query = "";
      input.value = "";
      selectedIndex = 0;
    }
    render();
    if (reopening) return;
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
    queueMicrotask(() => input.focus());
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    doc.removeEventListener("keydown", onKeyDown, true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (entries.length > 0) {
        selectedIndex = (selectedIndex + 1) % entries.length;
        updateSelection();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length > 0) {
        selectedIndex = (selectedIndex - 1 + entries.length) % entries.length;
        updateSelection();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateSelected();
    }
  };

  return {
    open,
    toggle(nextMode) {
      if (root.hidden) open(nextMode);
      else if (nextMode !== mode) open(nextMode);
      else close();
    },
    close,
    refresh() {
      if (!root.hidden) render();
    },
  };
}
