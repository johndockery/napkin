import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

export type CleanupFn = () => void;
export type PaneMountState = "new" | "mounting" | "ready" | "disposed";
export type SplitDirection = "horizontal" | "vertical";
export type NavigationDirection = "left" | "right" | "up" | "down";

/**
 * Observable state of a pane. Set implicitly by OSC 133 marks or explicitly
 * by an agent hook (`napkin hook <state>`), which overrides the inferred
 * state until the next transition.
 */
export type PaneRunState =
  | "idle"
  | "running"
  | "waiting"
  | "ok"
  | "error";

export interface LeafPane {
  readonly type: "leaf";
  parent: SplitPane | null;
  readonly tab: Tab;
  readonly element: HTMLDivElement;
  readonly terminalHostElement: HTMLDivElement;
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
  readonly cleanup: CleanupFn[];
  resizeObserver: ResizeObserver | null;
  sessionId: string | null;
  mountState: PaneMountState;
  cwd: string;
  runState: PaneRunState;
  /** Foreground agent name (e.g. "claude", "codex") or null when none. */
  agent: string | null;
}

export interface SplitPane {
  readonly type: "split";
  parent: SplitPane | null;
  readonly direction: SplitDirection;
  ratio: number;
  a: PaneNode;
  b: PaneNode;
  readonly element: HTMLDivElement;
  readonly aElement: HTMLDivElement;
  readonly bElement: HTMLDivElement;
  readonly resizerElement: HTMLDivElement;
}

export type PaneNode = LeafPane | SplitPane;

export interface Tab {
  readonly id: string;
  readonly element: HTMLDivElement;
  readonly labelElement: HTMLSpanElement;
  readonly statusElement: HTMLSpanElement;
  readonly agentElement: HTMLSpanElement;
  readonly closeButton: HTMLButtonElement;
  root: PaneNode | null;
  activeLeaf: LeafPane | null;
  broadcastInput: boolean;
  customName: string | null;
}

export interface AppElements {
  readonly container: HTMLDivElement;
  readonly tabStrip: HTMLDivElement;
  readonly newTabButton: HTMLButtonElement;
}

export interface AppState {
  readonly elements: AppElements;
  readonly leavesBySessionId: Map<string, LeafPane>;
  readonly tabs: Tab[];
  activeTab: Tab | null;
  nextTabId: number;
  fontSize: number;
}

export function getTabRoot(tab: Tab): PaneNode {
  if (!tab.root) {
    throw new Error(`tab ${tab.id} is missing a root pane`);
  }
  return tab.root;
}
