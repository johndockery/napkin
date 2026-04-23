//! Register a link provider on an xterm Terminal so file-path tokens in
//! output are clickable and open in $EDITOR.

import type { IBufferRange, ILink, Terminal } from "@xterm/xterm";

import { openInEditor } from "./ipc.ts";

/**
 * Match file paths with optional line and column suffixes:
 *
 *   src/foo.ts
 *   src/foo.ts:42
 *   src/foo.ts:42:5
 *   /abs/path/foo.py:42
 *   ./rel/path/foo.js
 *
 * Guarded against URL-like prefixes (http://, file://) which the web-links
 * addon already handles.
 */
const PATH_PATTERN =
  // eslint-disable-next-line no-useless-escape
  /(?<![\w:\/])([\.\/~][^\s:()'"<>]*?\.[a-zA-Z0-9]+)(?::(\d+)(?::(\d+))?)?(?=[\s)\]'"<>]|$)/g;

export function registerFilePathLinks(
  terminal: Terminal,
  reportError: (context: string, error: unknown) => void,
  getEditor: () => string | null = () => null,
): void {
  terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = bufferLineText(terminal, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      for (const match of line.matchAll(PATH_PATTERN)) {
        if (match.index === undefined) continue;
        const [, path, lineStr, colStr] = match;
        const startColumn = match.index + 1;
        const endColumn = startColumn + match[0].length;

        const range: IBufferRange = {
          start: { x: startColumn, y: bufferLineNumber },
          end: { x: endColumn, y: bufferLineNumber },
        };

        const lineNumber = lineStr ? Number.parseInt(lineStr, 10) : null;
        const columnNumber = colStr ? Number.parseInt(colStr, 10) : null;

        links.push({
          range,
          text: match[0],
          activate(_event: MouseEvent, _text: string) {
            void openInEditor(path, lineNumber, columnNumber, getEditor()).catch((error) => {
              reportError(`open_in_editor(${path})`, error);
            });
          },
        });
      }

      callback(links);
    },
  });
}

function bufferLineText(terminal: Terminal, lineIndex: number): string | null {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(lineIndex - 1);
  return line ? line.translateToString(true) : null;
}
