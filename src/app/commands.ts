//! Command palette — a keyboard-searchable list of every napkin action,
//! opened with Cmd+Shift+P. Actions carry their own keybinding label so
//! users who find a command here learn the shortcut.

export interface CommandEntry {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly shortcut?: string;
  readonly run: () => void;
}

export interface CommandPalette {
  toggle(): void;
  close(): void;
}

export interface CommandPaletteOptions {
  readonly listCommands: () => CommandEntry[];
}

export function createCommandPalette(
  doc: Document,
  options: CommandPaletteOptions,
): CommandPalette {
  const root = doc.createElement("div");
  root.className = "napkin-palette";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Command palette");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-palette-backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  const frame = doc.createElement("div");
  frame.className = "napkin-palette-frame";

  const header = doc.createElement("div");
  header.className = "napkin-palette-header";
  header.textContent = "Commands";

  const input = doc.createElement("input");
  input.type = "text";
  input.className = "napkin-palette-input";
  input.placeholder = "Type a command…";
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
  empty.textContent = "No commands match.";
  empty.hidden = true;

  const hint = doc.createElement("div");
  hint.className = "napkin-palette-hint";
  hint.textContent = "↑↓ to move · Enter to run · Esc to close";

  frame.append(header, input, list, empty, hint);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  let query = "";
  let entries: CommandEntry[] = [];
  let selectedIndex = 0;

  const matches = (command: CommandEntry): boolean => {
    if (query === "") return true;
    const haystack = `${command.title} ${command.category}`.toLowerCase();
    return haystack.includes(query);
  };

  const render = () => {
    entries = options.listCommands().filter(matches);
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

    entries.forEach((command, index) => {
      const item = doc.createElement("li");
      item.className = "napkin-palette-item napkin-command-item";
      if (index === selectedIndex) item.dataset.active = "true";

      const category = doc.createElement("span");
      category.className = "napkin-command-category";
      category.textContent = command.category;

      const title = doc.createElement("span");
      title.className = "napkin-palette-label";
      title.textContent = command.title;

      item.append(category, title);

      if (command.shortcut) {
        const shortcut = doc.createElement("span");
        shortcut.className = "napkin-command-shortcut";
        shortcut.textContent = command.shortcut;
        item.appendChild(shortcut);
      }

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
    const command = entries[selectedIndex];
    if (!command) return;
    close();
    command.run();
  };

  const open = () => {
    if (!root.hidden) {
      input.focus();
      input.select();
      return;
    }
    query = "";
    input.value = "";
    selectedIndex = 0;
    render();
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
    toggle() {
      if (root.hidden) open();
      else close();
    },
    close,
  };
}
