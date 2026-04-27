# Changelog

## [0.3.1] — 2026-04-27

### Fixes
- Tauri setup no longer blocks the main thread on the napkind unix-socket
  connect. The connect (and any spawn-and-wait for napkind) runs on a
  worker thread; commands made before the daemon comes up wait on a
  condvar instead. Cold launches no longer beach-ball.
- Zsh sessions now launch as login shells (`-l`) by default so
  `/etc/zprofile` (and `path_helper`) seed `/opt/homebrew/bin`,
  `/usr/local/bin`, and friends. Without this, panes spawned from the
  GUI inherited launchd's stripped PATH and Homebrew tools looked
  missing. Skipped if the user already passes `-l` / `--login` via
  `[shell] args`.
- Corrected the `[shell] program` default-value comment in the annotated
  config template (`/bin/bash` → `/bin/zsh`).

## [0.3.0] — 2026-04-23

### Product
- Added Agent Mission Control (`Cmd+Shift+O`) for scanning every pane,
  focusing agents, pause/resume, write-locking, killing panes, launching
  agents from task prompts, and opening the diff inbox.
- Added workspace snapshots that restore tabs, split layout, active panes,
  daemon session attachments, cwd, tab colors, bookmarks, and write-locks.
- Added a diff inbox so agent-submitted diffs remain reviewable with
  pending / accepted / rejected state.
- Upgraded command history into a command timeline that loads recent
  commands immediately, copies the selected command, and jumps to the live
  pane when possible.
- Broadcast mode now confirms the number of unlocked target panes before
  enabling fan-out.

### Fixes
- Exposed daemon pause/resume controls to the Tauri UI.
- Added safer editor command parsing and wired configured editor support
  through file-link handling.
- Added regression coverage for OSC parsing, agent classification, session
  spawning, SQLite-backed scrollback, and command history.
- Updated install/docs drift around TOML config, legacy JSON fallback, and
  the public installer URL.

## [0.2.0] — 2026-04-23

### Fixes
- Configuration now uses the documented TOML path
  (`~/.config/napkin/config.toml`) while retaining legacy JSON fallback.
- File drops now write directly to the targeted pane instead of flowing
  through terminal paste / broadcast input.
- Closing a pane now fully tears down its daemon session and forgets its
  resurrectable scrollback state.
- Shells launched by `napkind` scrub `NO_COLOR` and identify
  `TERM_PROGRAM=napkin`, which restores normal colour behaviour in agent
  CLIs.
- PTY output is decoded as streaming UTF-8 per pane so split multibyte
  sequences stop corrupting full-screen agent UIs.
- App launch opens a fresh tab instead of auto-reattaching every daemon
  session into the window.

## [0.1.0] — 2026-04-22

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
- Config at `~/.config/napkin/config.json` with theme and font overrides
  (replaced by TOML config in 0.2.0).
- Session scrollback capped at 2 MB in-memory per pane; spilled to
  SQLite in 64 KB chunks for post-restart replay.
- Broken JSON in the config file logs and falls back to defaults
  instead of refusing to start.

### Known gaps
- Codesigning / notarisation not yet wired — macOS gate requires
  right-click → Open on first launch.
- `napkin ssh` remote daemon with tunneled socket is v0.2.
- Windows support is v0.3+.
