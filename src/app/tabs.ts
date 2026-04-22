import type { PaneRunState, Tab } from "./types.ts";

export interface TabEventHandlers {
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onRenameRequested: () => void;
  readonly onReorder: (draggedId: string, beforeId: string | null) => void;
  readonly onContextMenu: (anchor: HTMLElement) => void;
}

export interface TabElements {
  readonly element: HTMLDivElement;
  readonly statusElement: HTMLSpanElement;
  readonly agentElement: HTMLSpanElement;
  readonly labelElement: HTMLSpanElement;
  readonly closeButton: HTMLButtonElement;
}

export function createTabElements(id: string): TabElements {
  const element = document.createElement("div");
  element.className = "tab";
  element.dataset.id = id;

  const statusElement = document.createElement("span");
  statusElement.className = "tab-status";
  statusElement.dataset.state = "idle";
  statusElement.setAttribute("aria-hidden", "true");

  const agentElement = document.createElement("span");
  agentElement.className = "tab-agent";
  agentElement.hidden = true;

  const labelElement = document.createElement("span");
  labelElement.className = "tab-label";
  labelElement.textContent = "~";

  const closeButton = document.createElement("button");
  closeButton.className = "tab-close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = "Close tab";

  element.append(statusElement, agentElement, labelElement, closeButton);

  return {
    element,
    statusElement,
    agentElement,
    labelElement,
    closeButton,
  };
}

export function setTabRunState(tab: Tab, state: PaneRunState): void {
  tab.statusElement.dataset.state = state;
}

export function setTabAgent(tab: Tab, agent: string | null): void {
  if (!agent) {
    tab.agentElement.hidden = true;
    tab.agentElement.textContent = "";
    delete tab.agentElement.dataset.agent;
    return;
  }
  tab.agentElement.hidden = false;
  tab.agentElement.textContent = agent;
  tab.agentElement.dataset.agent = agent;
}

export function bindTabEvents(tab: Tab, handlers: TabEventHandlers): void {
  tab.closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    handlers.onClose();
  });

  tab.element.addEventListener("mousedown", (event) => {
    if ((event.target as HTMLElement).closest(".tab-close")) {
      return;
    }
    handlers.onActivate();
  });

  tab.labelElement.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    handlers.onRenameRequested();
  });

  tab.element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.onContextMenu(tab.element);
  });

  tab.element.draggable = true;

  tab.element.addEventListener("dragstart", (event) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-napkin-tab", tab.id);
    tab.element.classList.add("dragging");
  });

  tab.element.addEventListener("dragend", () => {
    tab.element.classList.remove("dragging");
  });

  tab.element.addEventListener("dragover", (event) => {
    if (!event.dataTransfer) return;
    // Only treat this as a reorder when the payload is one of our tabs.
    const types = Array.from(event.dataTransfer.types);
    if (!types.includes("application/x-napkin-tab")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    tab.element.classList.add("drop-target");
  });

  tab.element.addEventListener("dragleave", () => {
    tab.element.classList.remove("drop-target");
  });

  tab.element.addEventListener("drop", (event) => {
    if (!event.dataTransfer) return;
    const draggedId = event.dataTransfer.getData("application/x-napkin-tab");
    tab.element.classList.remove("drop-target");
    if (!draggedId || draggedId === tab.id) return;
    event.preventDefault();

    // Decide whether to insert before or after the drop target based on
    // where the cursor fell within the tab's horizontal bounds.
    const bounds = tab.element.getBoundingClientRect();
    const dropBeforeThisTab = event.clientX < bounds.left + bounds.width / 2;
    handlers.onReorder(draggedId, dropBeforeThisTab ? tab.id : nextTabId(tab));
  });
}

/**
 * The id of the tab element immediately after `tab` in the DOM, or null if
 * `tab` is the last tab before the "new tab" button.
 */
function nextTabId(tab: Tab): string | null {
  const sibling = tab.element.nextElementSibling;
  if (!sibling || !(sibling instanceof HTMLElement) || !sibling.classList.contains("tab")) {
    return null;
  }
  return sibling.dataset.id ?? null;
}

export function mountTab(
  tab: Tab,
  tabStrip: HTMLDivElement,
  newTabButton: HTMLButtonElement,
): void {
  tabStrip.insertBefore(tab.element, newTabButton);
}

export function startTabRename(
  tab: Tab,
  onCommit: () => void,
): void {
  const originalName = tab.customName ?? tab.labelElement.textContent ?? "";
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = originalName;
  input.spellcheck = false;

  tab.labelElement.replaceWith(input);
  input.focus();
  input.select();

  const commit = (save: boolean) => {
    const nextName = input.value.trim();
    if (save) {
      tab.customName = nextName === "" ? null : nextName;
    }
    input.replaceWith(tab.labelElement);
    onCommit();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

export function updateTabLabel(tab: Tab): void {
  if (tab.customName) {
    tab.labelElement.textContent = tab.customName;
    tab.labelElement.title = tab.customName;
    return;
  }

  const cwd = tab.activeLeaf?.cwd ?? "~";
  const shortPath = cwd
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
  const segments = shortPath.split("/").filter(Boolean);
  const label = shortPath === "~" ? "~" : (segments[segments.length - 1] ?? "~");

  tab.labelElement.textContent = label;
  tab.labelElement.title = shortPath;
}
