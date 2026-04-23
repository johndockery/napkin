import type { Window } from "@tauri-apps/api/window";

import { writePty } from "./ipc.ts";
import type { LeafPane } from "./types.ts";

export interface FileDropOptions {
  readonly appWindow: Window;
  readonly listLeaves: () => ReadonlyArray<LeafPane>;
  readonly getActiveLeaf: () => LeafPane | null;
  readonly focusLeaf: (leaf: LeafPane) => void;
  readonly reportInvokeError: (context: string, error: unknown) => void;
}

const dropEncoder = new TextEncoder();

/**
 * Route OS-level file drops into the terminal as a shell-escaped paste.
 * This makes Finder/image drops behave like a normal terminal file drop,
 * which is what agent CLIs typically expect.
 */
export async function registerFileDropPaste(options: FileDropOptions): Promise<void> {
  let highlightedLeaf: LeafPane | null = null;

  const setHighlightedLeaf = (nextLeaf: LeafPane | null): void => {
    if (highlightedLeaf === nextLeaf) {
      return;
    }
    highlightedLeaf?.element.classList.remove("file-drop-target");
    highlightedLeaf = nextLeaf;
    highlightedLeaf?.element.classList.add("file-drop-target");
  };

  await options.appWindow.onDragDropEvent((event) => {
    const { payload } = event;

    switch (payload.type) {
      case "leave":
        setHighlightedLeaf(null);
        return;
      case "enter":
      case "over":
        setHighlightedLeaf(resolveDropTarget(payload.position, options));
        return;
      case "drop": {
        const target = resolveDropTarget(payload.position, options) ?? options.getActiveLeaf();
        setHighlightedLeaf(null);
        if (!target || payload.paths.length === 0) {
          return;
        }
        options.focusLeaf(target);
        if (!target.sessionId) {
          return;
        }
        const payloadBytes = Array.from(
          dropEncoder.encode(`${payload.paths.map(shellEscapePath).join(" ")} `),
        );
        void writePty(target.sessionId, payloadBytes).catch((error) => {
          options.reportInvokeError(`pty_write(${target.sessionId})`, error);
        });
      }
    }
  });
}

function resolveDropTarget(
  position: { readonly x: number; readonly y: number },
  options: Pick<FileDropOptions, "listLeaves" | "getActiveLeaf">,
): LeafPane | null {
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;

  for (const leaf of options.listLeaves()) {
    if (leaf.mountState === "disposed") {
      continue;
    }
    const bounds = leaf.element.getBoundingClientRect();
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
      return leaf;
    }
  }

  return options.getActiveLeaf();
}

function shellEscapePath(path: string): string {
  return `'${path.replace(/'/g, `'\"'\"'`)}'`;
}
