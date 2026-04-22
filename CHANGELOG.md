# Changelog

## [0.1.0] — unreleased

First public build. Everything on the landing page is a real feature.

### Workspace
- Pane splits and tabs, drag-resize, keyboard nav, per-tab colour, tab
  reorder by drag, broadcast input with scope-aware write-locks.
- Persistent `napkind` daemon owns PTY + session state; UI is
  disposable.
- Session resurrection: recent sessions rehydrate from disk after a
  daemon or machine restart with cwd + scrollback intact.

### Shell integration
- OSC 133 prompt / command / exit-code marks for zsh, bash, fish, and
  nushell.
- `Cmd+↑` / `Cmd+↓` walk between prompt boundaries.
- `Cmd+Shift+M` pins a scrollback position; bookmarks surface in the
  command palette.
- Inline image protocols (Sixel, iTerm2) via `@xterm/addon-image`.
- Clickable file paths open in `$EDITOR` (VS Code / Cursor / other).
- OSC 52 clipboard passthrough works across nested SSH hops.

### Agent era
- Command-name agent detection (claude, codex, cursor, aider, opencode,
  gemini); coloured badge per tab.
- `napkin hook <state> [--agent NAME] [--tokens N] [--cost USD]` lets
  agents drive exact semantic state; pipes through the daemon into the
  pane, the palette metrics pill, and OS notifications.
- `napkin diff [--file F | --stdin]` surfaces unified diffs as an
  overlay; Enter accepts, Esc rejects, CLI exits 0/1 for the agent.
- `napkin pause <session>` / `napkin resume <session>` SIGSTOP / SIGCONT
  the shell.
- `Cmd+J` jumps to the next waiting agent; `Cmd+Shift+A` opens the
  agent palette.

### Search, history, navigation
- `Cmd+F` in-pane search (xterm-addon-search).
- `Cmd+Shift+F` cross-session search over SQLite-persisted command
  history.
- `Cmd+P` pane palette with live fuzzy search; `Cmd+Shift+P` command
  palette with every shortcut discoverable.
- `Cmd+/` keyboard shortcut cheatsheet overlay.

### Daemon + CLI
- Unix-socket protocol documented in `crates/napkin-proto`.
- `napkin list` / `napkin attach <session>` from any terminal.
- `napkin workspace new <branch>` drops a git worktree under
  `<repo>/.napkin-worktrees/` for agent isolation.

### Runtime
- Config at `~/.config/napkin/config.json` with theme and font overrides.
- Session scrollback capped at 2 MB in-memory per pane; spilled to
  SQLite in 64 KB chunks for post-restart replay.
- Broken JSON in the config file logs and falls back to defaults
  instead of refusing to start.

### Known gaps
- Codesigning / notarisation not yet wired — macOS gate requires
  right-click → Open on first launch.
- `napkin ssh` remote daemon with tunneled socket is v0.2.
- Windows support is v0.3+.
