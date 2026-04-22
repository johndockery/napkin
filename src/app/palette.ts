//! Agent palette: an overlay listing every pane in the workspace that has a
//! running agent, with keyboard-driven navigation and jump-to-pane.
//!
//! Opened via Cmd+Shift+A. Esc or backdrop click closes.

import type { LeafPane, PaneRunState } from "./types.ts";

export interface AgentPaletteEntry {
  readonly tabLabel: string;
  readonly cwd: string;
  readonly agent: string;
  readonly runState: PaneRunState;
  readonly leaf: LeafPane;
}

export interface AgentPalette {
  toggle(): void;
  close(): void;
  refresh(): void;
}

export interface AgentPaletteOptions {
  readonly listEntries: () => AgentPaletteEntry[];
  readonly onSelect: (leaf: LeafPane) => void;
}

export function createAgentPalette(
  doc: Document,
  options: AgentPaletteOptions,
): AgentPalette {
  const root = doc.createElement("div");
  root.className = "napkin-palette";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Active agents");

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
  header.textContent = "Active agents";

  const hint = doc.createElement("div");
  hint.className = "napkin-palette-hint";
  hint.textContent = "↑↓ to move · Enter to jump · Esc to close";

  const list = doc.createElement("ul");
  list.className = "napkin-palette-list";

  const empty = doc.createElement("div");
  empty.className = "napkin-palette-empty";
  empty.textContent = "No agents running.";

  frame.append(header, list, empty, hint);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  let entries: AgentPaletteEntry[] = [];
  let selectedIndex = 0;

  const render = () => {
    entries = options.listEntries();
    list.replaceChildren();
    if (entries.length === 0) {
      list.hidden = true;
      empty.hidden = false;
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

      const badge = doc.createElement("span");
      badge.className = "napkin-palette-agent tab-agent";
      badge.dataset.agent = entry.agent;
      badge.textContent = entry.agent;

      const dot = doc.createElement("span");
      dot.className = "napkin-palette-dot tab-status";
      dot.dataset.state = entry.runState;

      const label = doc.createElement("span");
      label.className = "napkin-palette-label";
      label.textContent = entry.tabLabel;

      const path = doc.createElement("span");
      path.className = "napkin-palette-cwd";
      path.textContent = entry.cwd;

      item.append(dot, badge, label, path);
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
    if (!entry) {
      return;
    }
    close();
    options.onSelect(entry.leaf);
  };

  const open = () => {
    if (!root.hidden) {
      return;
    }
    render();
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
  };

  const close = () => {
    if (root.hidden) {
      return;
    }
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
    toggle() {
      if (root.hidden) {
        open();
      } else {
        close();
      }
    },
    close,
    refresh() {
      if (!root.hidden) {
        render();
      }
    },
  };
}
