import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface RawPtyOutputEvent {
  readonly session_id: string;
  readonly data: number[];
}

interface RawPaneCwdEvent {
  readonly session_id: string;
  readonly cwd: string;
}

interface RawPtyExitEvent {
  readonly session_id: string;
}

interface RawPaneMarkEvent {
  readonly session_id: string;
  readonly mark: string;
  readonly exit?: number | null;
}

interface RawPaneAgentEvent {
  readonly session_id: string;
  readonly agent?: string | null;
}

export interface PtySpawnArgs {
  readonly rows: number;
  readonly cols: number;
  readonly cwd?: string;
  readonly shell?: string;
}

export interface PtyOutputEvent {
  readonly sessionId: string;
  readonly data: readonly number[];
}

export interface PaneCwdEvent {
  readonly sessionId: string;
  readonly cwd: string;
}

export interface PtyExitEvent {
  readonly sessionId: string;
}

/** OSC 133 shell mark. A = prompt, C = command start, D = command end. */
export interface PaneMarkEvent {
  readonly sessionId: string;
  readonly mark: "A" | "B" | "C" | "D";
  readonly exit: number | null;
}

/** The foreground command on a pane has been classified (or cleared). */
export interface PaneAgentEvent {
  readonly sessionId: string;
  readonly agent: string | null;
}

export async function spawnPty(args: PtySpawnArgs): Promise<string> {
  return invoke<string>("pty_spawn", { args });
}

export async function writePty(
  sessionId: string,
  data: ReadonlyArray<number>,
): Promise<void> {
  await invoke("pty_write", { sessionId, data });
}

export async function resizePty(
  sessionId: string,
  rows: number,
  cols: number,
): Promise<void> {
  await invoke("pty_resize", { sessionId, rows, cols });
}

export async function killPty(sessionId: string): Promise<void> {
  await invoke("pty_kill", { sessionId });
}

export async function onPtyOutput(
  handler: (event: PtyOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawPtyOutputEvent>("pty-output", ({ payload }) => {
    handler({
      sessionId: payload.session_id,
      data: payload.data,
    });
  });
}

export async function onPaneCwd(
  handler: (event: PaneCwdEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawPaneCwdEvent>("pane-cwd", ({ payload }) => {
    handler({
      sessionId: payload.session_id,
      cwd: payload.cwd,
    });
  });
}

export async function onPtyExit(
  handler: (event: PtyExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawPtyExitEvent>("pty-exit", ({ payload }) => {
    handler({
      sessionId: payload.session_id,
    });
  });
}

export async function onPaneMark(
  handler: (event: PaneMarkEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawPaneMarkEvent>("pane-mark", ({ payload }) => {
    const mark = payload.mark as PaneMarkEvent["mark"];
    if (mark !== "A" && mark !== "B" && mark !== "C" && mark !== "D") {
      return;
    }
    handler({
      sessionId: payload.session_id,
      mark,
      exit: payload.exit ?? null,
    });
  });
}

export async function onPaneAgent(
  handler: (event: PaneAgentEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawPaneAgentEvent>("pane-agent", ({ payload }) => {
    handler({
      sessionId: payload.session_id,
      agent: payload.agent ?? null,
    });
  });
}
