import type { PaneRunState, Tab } from "./types.ts";

export interface TabEventHandlers {
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onRenameRequested: () => void;
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
