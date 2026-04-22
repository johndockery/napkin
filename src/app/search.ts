//! Pane-local search bar. Toggled via Cmd+F; operates on the active leaf's
//! xterm search addon. Enter/Cmd+G = next match; Shift+Enter/Cmd+Shift+G =
//! previous; Esc closes.

import type { LeafPane } from "./types.ts";

export interface SearchController {
  open(): void;
  close(): void;
  toggle(): void;
  findNext(): void;
  findPrevious(): void;
}

export interface SearchOptions {
  readonly getActiveLeaf: () => LeafPane | null;
}

export function createSearchController(
  doc: Document,
  options: SearchOptions,
): SearchController {
  const root = doc.createElement("div");
  root.className = "napkin-search";
  root.hidden = true;

  const label = doc.createElement("span");
  label.className = "napkin-search-label";
  label.textContent = "find";

  const input = doc.createElement("input");
  input.type = "text";
  input.className = "napkin-search-input";
  input.placeholder = "search pane…";
  input.spellcheck = false;
  input.autocomplete = "off";

  const status = doc.createElement("span");
  status.className = "napkin-search-status";

  const prevBtn = doc.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "napkin-search-button";
  prevBtn.title = "Previous (⇧↵)";
  prevBtn.textContent = "↑";

  const nextBtn = doc.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "napkin-search-button";
  nextBtn.title = "Next (↵)";
  nextBtn.textContent = "↓";

  const closeBtn = doc.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "napkin-search-button";
  closeBtn.title = "Close (Esc)";
  closeBtn.textContent = "×";

  root.append(label, input, status, prevBtn, nextBtn, closeBtn);
  doc.body.appendChild(root);

  let activeLeaf: LeafPane | null = null;

  const bindLeaf = (): LeafPane | null => {
    activeLeaf = options.getActiveLeaf();
    return activeLeaf;
  };

  const findNext = () => {
    if (!bindLeaf() || input.value === "") return;
    activeLeaf?.searchAddon.findNext(input.value);
  };

  const findPrevious = () => {
    if (!bindLeaf() || input.value === "") return;
    activeLeaf?.searchAddon.findPrevious(input.value);
  };

  const open = () => {
    if (!root.hidden) {
      input.focus();
      input.select();
      return;
    }
    bindLeaf();
    root.hidden = false;
    input.focus();
    input.select();
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    activeLeaf?.searchAddon.clearDecorations();
    activeLeaf?.terminal.focus();
    activeLeaf = null;
  };

  input.addEventListener("input", () => {
    findNext();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) findPrevious();
      else findNext();
    }
  });
  nextBtn.addEventListener("click", findNext);
  prevBtn.addEventListener("click", findPrevious);
  closeBtn.addEventListener("click", close);

  return {
    open,
    close,
    toggle: () => (root.hidden ? open() : close()),
    findNext,
    findPrevious,
  };
}
