//! Global command timeline palette (Cmd+Shift+F).
//!
//! Queries napkind's SQLite history table for commands matching the query
//! and renders them newest-first. Selection can hand the chosen command
//! back to the workspace so live sessions can be focused.

import { searchHistory, type HistoryEntry } from "./ipc.ts";

export interface HistoryPalette {
  toggle(): void;
  close(): void;
}

export interface HistoryPaletteOptions {
  readonly onSelect?: (entry: HistoryEntry) => void;
}

const DEFAULT_LIMIT = 200;

export function createHistoryPalette(
  doc: Document,
  options: HistoryPaletteOptions = {},
): HistoryPalette {
  const root = doc.createElement("div");
  root.className = "napkin-palette";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Command timeline");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-palette-backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  const frame = doc.createElement("div");
  frame.className = "napkin-palette-frame";

  const header = doc.createElement("div");
  header.className = "napkin-palette-header";
  header.textContent = "Command timeline";

  const input = doc.createElement("input");
  input.type = "text";
  input.className = "napkin-palette-input";
  input.placeholder = "Search every command napkin has recorded...";
  input.spellcheck = false;
  input.autocomplete = "off";

  const list = doc.createElement("ul");
  list.className = "napkin-palette-list";

  const empty = doc.createElement("div");
  empty.className = "napkin-palette-empty";
  empty.textContent = "No commands recorded yet.";
  empty.hidden = true;

  const hint = doc.createElement("div");
  hint.className = "napkin-palette-hint";
  hint.textContent = "Enter to jump/copy · Searches every recorded session · Esc to close";

  frame.append(header, input, list, empty, hint);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  let results: HistoryEntry[] = [];
  let selectedIndex = 0;
  let activeQueryId = 0;

  const formatTime = (ms: number): string => {
    const date = new Date(ms);
    const today = new Date();
    const sameDay =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate();
    const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return hhmm;
    const mmdd = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return `${mmdd} ${hhmm}`;
  };

  const render = () => {
    list.replaceChildren();
    if (results.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    list.hidden = false;
    empty.hidden = true;
    selectedIndex = Math.min(selectedIndex, results.length - 1);

    results.forEach((entry, index) => {
      const item = doc.createElement("li");
      item.className = "napkin-palette-item napkin-history-item";
      if (index === selectedIndex) item.dataset.active = "true";

      const when = doc.createElement("span");
      when.className = "napkin-history-when";
      when.textContent = formatTime(entry.started_at_ms);

      const cmd = doc.createElement("span");
      cmd.className = "napkin-palette-label napkin-history-cmd";
      cmd.textContent = entry.cmd;

      const cwd = doc.createElement("span");
      cwd.className = "napkin-palette-cwd";
      cwd.textContent = entry.cwd;

      if (entry.exit_code !== null && entry.exit_code !== 0) {
        const bad = doc.createElement("span");
        bad.className = "napkin-history-exit";
        bad.textContent = `exit ${entry.exit_code}`;
        item.append(when, cmd, bad, cwd);
      } else {
        item.append(when, cmd, cwd);
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
    const entry = results[selectedIndex];
    if (!entry) return;
    if (options.onSelect) {
      options.onSelect(entry);
    } else {
      void navigator.clipboard.writeText(entry.cmd).catch(() => {});
    }
    close();
  };

  const runQuery = async (query: string): Promise<void> => {
    activeQueryId += 1;
    const myId = activeQueryId;
    try {
      const fresh = await searchHistory(query, DEFAULT_LIMIT);
      if (myId !== activeQueryId) return;
      results = fresh;
      selectedIndex = 0;
      render();
    } catch {
      if (myId !== activeQueryId) return;
      results = [];
      render();
    }
  };

  let debounce: number | null = null;
  input.addEventListener("input", () => {
    if (debounce !== null) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      debounce = null;
      void runQuery(input.value);
    }, 100);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex + 1) % results.length;
        updateSelection();
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length > 0) {
        selectedIndex = (selectedIndex - 1 + results.length) % results.length;
        updateSelection();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activateSelected();
    }
  };

  const open = () => {
    if (!root.hidden) {
      input.focus();
      input.select();
      return;
    }
    results = [];
    selectedIndex = 0;
    input.value = "";
    render();
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
    void runQuery("");
    queueMicrotask(() => input.focus());
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
