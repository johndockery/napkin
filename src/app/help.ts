//! Keyboard shortcut help overlay. Cmd+/ toggles; Esc closes.
//! Pure-render; no input beyond Escape.

interface Shortcut {
  readonly keys: string;
  readonly description: string;
}

interface Section {
  readonly title: string;
  readonly shortcuts: readonly Shortcut[];
}

const SECTIONS: readonly Section[] = [
  {
    title: "Tabs",
    shortcuts: [
      { keys: "⌘T", description: "New tab" },
      { keys: "⌘W", description: "Close pane (last pane closes tab)" },
      { keys: "⌘1–9", description: "Jump to tab N" },
      { keys: "⌘⇧[ / ⌘⇧]", description: "Previous / next tab" },
      { keys: "Double-click label", description: "Rename tab" },
      { keys: "Drag a tab", description: "Reorder" },
    ],
  },
  {
    title: "Panes",
    shortcuts: [
      { keys: "⌘D", description: "Split horizontally" },
      { keys: "⌘⇧D", description: "Split vertically" },
      { keys: "⌘⇧←↑→↓", description: "Focus neighbour pane" },
      { keys: "Drag divider", description: "Resize" },
      { keys: "⌘⇧B", description: "Toggle broadcast input" },
      { keys: "⌘K", description: "Clear active pane" },
    ],
  },
  {
    title: "Search & navigation",
    shortcuts: [
      { keys: "⌘P", description: "Pane palette" },
      { keys: "⌘⇧P", description: "Command palette" },
      { keys: "⌘J", description: "Jump to next waiting agent" },
      { keys: "⌘⇧A", description: "Agent palette" },
      { keys: "⌘F", description: "Search within pane" },
      { keys: "⌘G / ⌘⇧G", description: "Next / previous match" },
      { keys: "⌘↑ / ⌘↓", description: "Jump between prompts in the pane" },
    ],
  },
  {
    title: "Display",
    shortcuts: [
      { keys: "⌘= / ⌘-", description: "Font larger / smaller" },
      { keys: "⌘0", description: "Reset font size" },
      { keys: "⌘/", description: "Toggle this help" },
    ],
  },
];

export interface HelpOverlay {
  toggle(): void;
  close(): void;
}

export function createHelpOverlay(doc: Document): HelpOverlay {
  const root = doc.createElement("div");
  root.className = "napkin-help";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Keyboard shortcuts");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-help-backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  const frame = doc.createElement("div");
  frame.className = "napkin-help-frame";

  const header = doc.createElement("div");
  header.className = "napkin-help-header";
  header.textContent = "Keyboard shortcuts";

  const grid = doc.createElement("div");
  grid.className = "napkin-help-grid";
  for (const section of SECTIONS) {
    const column = doc.createElement("div");
    column.className = "napkin-help-section";

    const title = doc.createElement("div");
    title.className = "napkin-help-section-title";
    title.textContent = section.title;
    column.appendChild(title);

    for (const shortcut of section.shortcuts) {
      const row = doc.createElement("div");
      row.className = "napkin-help-row";

      const keys = doc.createElement("kbd");
      keys.textContent = shortcut.keys;

      const description = doc.createElement("span");
      description.textContent = shortcut.description;

      row.append(keys, description);
      column.appendChild(row);
    }

    grid.appendChild(column);
  }

  const hint = doc.createElement("div");
  hint.className = "napkin-help-hint";
  hint.textContent = "Esc to close · ⌘/ to toggle";

  frame.append(header, grid, hint);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const open = () => {
    if (!root.hidden) return;
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    doc.removeEventListener("keydown", onKeyDown, true);
  };

  return {
    toggle() {
      if (root.hidden) open();
      else close();
    },
    close,
  };
}
