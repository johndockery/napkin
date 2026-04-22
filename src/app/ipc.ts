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
