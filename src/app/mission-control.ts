import type { LeafPane, PaneRunState } from "./types.ts";

export interface MissionControlEntry {
  readonly tabLabel: string;
  readonly cwd: string;
  readonly agent: string | null;
  readonly runState: PaneRunState;
  readonly sessionId: string | null;
  readonly tokens: number | null;
  readonly costUsd: number | null;
  readonly runningSince: number | null;
  readonly writeLocked: boolean;
  readonly leaf: LeafPane;
}

export interface MissionControl {
  open(): void;
  toggle(): void;
  close(): void;
  refresh(): void;
}

export interface MissionControlOptions {
  readonly listEntries: () => MissionControlEntry[];
  readonly onFocus: (leaf: LeafPane) => void;
  readonly onPause: (leaf: LeafPane) => Promise<void> | void;
  readonly onResume: (leaf: LeafPane) => Promise<void> | void;
  readonly onKill: (leaf: LeafPane) => Promise<void> | void;
  readonly onToggleWriteLock: (leaf: LeafPane) => void;
  readonly onLaunchAgent: (provider: string, task: string) => Promise<void> | void;
  readonly onOpenDiffInbox: () => void;
}

const PROVIDERS = ["claude", "codex", "aider", "gemini", "opencode"] as const;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatMetrics(entry: MissionControlEntry): string {
  const bits: string[] = [];
  if (entry.runningSince !== null) bits.push(formatElapsed(entry.runningSince));
  if (entry.tokens !== null) bits.push(formatTokens(entry.tokens));
  if (entry.costUsd !== null) bits.push(`$${entry.costUsd.toFixed(2)}`);
  return bits.join(" / ");
}

function runAction(action: () => Promise<void> | void): void {
  void Promise.resolve(action()).catch((error) => {
    console.warn("[napkin/mission-control] action failed", error);
  });
}

export function createMissionControl(
  doc: Document,
  options: MissionControlOptions,
): MissionControl {
  const root = doc.createElement("div");
  root.className = "napkin-mission";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Agent Mission Control");

  const backdrop = doc.createElement("div");
  backdrop.className = "napkin-mission-backdrop";
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });

  const frame = doc.createElement("div");
  frame.className = "napkin-mission-frame";

  const header = doc.createElement("div");
  header.className = "napkin-mission-header";

  const title = doc.createElement("div");
  title.className = "napkin-mission-title";
  title.textContent = "Agent Mission Control";

  const summary = doc.createElement("div");
  summary.className = "napkin-mission-summary";

  header.append(title, summary);

  const launch = doc.createElement("form");
  launch.className = "napkin-mission-launch";

  const providerSelect = doc.createElement("select");
  providerSelect.className = "napkin-mission-select";
  providerSelect.setAttribute("aria-label", "Agent provider");
  for (const provider of PROVIDERS) {
    const option = doc.createElement("option");
    option.value = provider;
    option.textContent = provider;
    providerSelect.appendChild(option);
  }

  const taskInput = doc.createElement("input");
  taskInput.className = "napkin-mission-input";
  taskInput.type = "text";
  taskInput.placeholder = "Start an agent with a task...";
  taskInput.spellcheck = false;
  taskInput.autocomplete = "off";

  const launchButton = doc.createElement("button");
  launchButton.type = "submit";
  launchButton.className = "napkin-mission-button primary";
  launchButton.textContent = "Launch";

  const inboxButton = doc.createElement("button");
  inboxButton.type = "button";
  inboxButton.className = "napkin-mission-button";
  inboxButton.textContent = "Diff inbox";
  inboxButton.addEventListener("click", () => {
    close();
    options.onOpenDiffInbox();
  });

  launch.append(providerSelect, taskInput, launchButton, inboxButton);

  const list = doc.createElement("div");
  list.className = "napkin-mission-list";

  const empty = doc.createElement("div");
  empty.className = "napkin-mission-empty";
  empty.textContent = "No panes yet.";

  frame.append(header, launch, list, empty);
  backdrop.appendChild(frame);
  root.appendChild(backdrop);
  doc.body.appendChild(root);

  let refreshTimer: number | null = null;

  const render = () => {
    const entries = options.listEntries();
    const agentCount = entries.filter((entry) => entry.agent !== null).length;
    const waitingCount = entries.filter((entry) => entry.runState === "waiting").length;
    const runningCount = entries.filter((entry) => entry.runState === "running").length;
    summary.textContent =
      `${entries.length} panes / ${agentCount} agents / ${runningCount} running / ${waitingCount} waiting`;

    list.replaceChildren();
    list.hidden = entries.length === 0;
    empty.hidden = entries.length > 0;

    for (const entry of entries) {
      const row = doc.createElement("div");
      row.className = "napkin-mission-row";

      const stateDot = doc.createElement("span");
      stateDot.className = "napkin-mission-dot tab-status";
      stateDot.dataset.state = entry.runState;
      stateDot.title = entry.runState;

      const main = doc.createElement("button");
      main.type = "button";
      main.className = "napkin-mission-main";
      main.addEventListener("click", () => {
        close();
        options.onFocus(entry.leaf);
      });

      const topLine = doc.createElement("span");
      topLine.className = "napkin-mission-topline";

      const label = doc.createElement("span");
      label.className = "napkin-mission-label";
      label.textContent = entry.tabLabel;
      topLine.appendChild(label);

      if (entry.agent) {
        const agent = doc.createElement("span");
        agent.className = "napkin-mission-agent tab-agent";
        agent.dataset.agent = entry.agent;
        agent.textContent = entry.agent;
        topLine.appendChild(agent);
      }

      if (entry.writeLocked) {
        const locked = doc.createElement("span");
        locked.className = "napkin-mission-lock";
        locked.textContent = "locked";
        topLine.appendChild(locked);
      }

      const cwd = doc.createElement("span");
      cwd.className = "napkin-mission-cwd";
      cwd.textContent = entry.cwd;

      main.append(topLine, cwd);

      const metrics = doc.createElement("span");
      metrics.className = "napkin-mission-metrics";
      metrics.textContent = formatMetrics(entry) || entry.runState;

      const actions = doc.createElement("div");
      actions.className = "napkin-mission-actions";

      const pause = doc.createElement("button");
      pause.type = "button";
      pause.className = "napkin-mission-icon-button";
      pause.textContent = "Pause";
      pause.disabled = entry.sessionId === null;
      pause.addEventListener("click", () => runAction(() => options.onPause(entry.leaf)));

      const resume = doc.createElement("button");
      resume.type = "button";
      resume.className = "napkin-mission-icon-button";
      resume.textContent = "Resume";
      resume.disabled = entry.sessionId === null;
      resume.addEventListener("click", () => runAction(() => options.onResume(entry.leaf)));

      const lock = doc.createElement("button");
      lock.type = "button";
      lock.className = "napkin-mission-icon-button";
      lock.textContent = entry.writeLocked ? "Unlock" : "Lock";
      lock.addEventListener("click", () => {
        options.onToggleWriteLock(entry.leaf);
        render();
      });

      const kill = doc.createElement("button");
      kill.type = "button";
      kill.className = "napkin-mission-icon-button danger";
      kill.textContent = "Kill";
      kill.disabled = entry.sessionId === null;
      kill.addEventListener("click", () => runAction(() => options.onKill(entry.leaf)));

      actions.append(pause, resume, lock, kill);
      row.append(stateDot, main, metrics, actions);
      list.appendChild(row);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const open = () => {
    render();
    if (!root.hidden) {
      taskInput.focus();
      return;
    }
    root.hidden = false;
    doc.addEventListener("keydown", onKeyDown, true);
    refreshTimer = window.setInterval(render, 1000);
    queueMicrotask(() => taskInput.focus());
  };

  const close = () => {
    if (root.hidden) return;
    root.hidden = true;
    doc.removeEventListener("keydown", onKeyDown, true);
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  };

  launch.addEventListener("submit", (event) => {
    event.preventDefault();
    const provider = providerSelect.value;
    const task = taskInput.value.trim();
    taskInput.value = "";
    close();
    runAction(() => options.onLaunchAgent(provider, task));
  });

  return {
    open,
    toggle() {
      if (root.hidden) open();
      else close();
    },
    close,
    refresh() {
      if (!root.hidden) render();
    },
  };
}
