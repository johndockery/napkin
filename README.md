# napkin

A fast terminal with first-class workspaces, structured scrollback,
and agent-awareness. Rust core + Tauri shell + xterm.js renderer.

Built because tmux has UX debt, Warp has a login wall, and neither
understands that you have six panes running agents at once.

> **Status:** pre-alpha. Works on macOS today. The public API (keybindings,
> env vars, socket protocol) is still fluid.

## Highlights

- **Tabs and pane splits** with drag-resize, keyboard navigation, per-tab
  rename, and broadcast input across a tab's panes
- **Persistent daemon** (`napkind`) owns the PTYs; the UI is disposable.
  Close napkin, reopen it, and every session comes back — with
  **scrollback replayed** from the daemon's ring buffer
- **OSC 133 shell integration** out of the box for zsh and bash, with
  prompt boundaries, exit codes, and cwd tracking
- **Agent detection** on command names (`claude`, `codex`, `cursor`,
  `aider`, `gemini`, `opencode`) with a coloured badge in the tab
- **Agent Mission Control** (`Cmd+Shift+O`) to scan every pane, pause/resume
  sessions, launch agents from a task prompt, and open the diff inbox
- **Agent hooks** via a small `napkin` CLI so Claude Code's `Stop` hook
  (and equivalents) can drive napkin with *exact* semantic state instead
  of inferred state
- **Background OS notifications** when an agent transitions to "waiting"
  or finishes while the window isn't focused
- **Palettes**: `Cmd+P` to jump to any pane; `Cmd+Shift+A` to filter to
  running agents
- **Workspace restore** remembers tabs, splits, attached daemon sessions,
  cwd, tab colors, and write locks between app launches
- **Command timeline** (`Cmd+Shift+F`) shows recent commands across sessions,
  copies the selected command, and jumps to the live pane when it still exists
- **Pane search** (`Cmd+F`) powered by xterm's search addon

## Keybindings

| Keys                         | Action                                         |
| ---------------------------- | ---------------------------------------------- |
| `Cmd+T`                      | New tab                                        |
| `Cmd+W`                      | Close pane; last pane in last tab closes window |
| `Cmd+1..9`                   | Jump to tab N                                  |
| `Cmd+Shift+[` / `Cmd+Shift+]` | Previous / next tab                           |
| `Cmd+D` / `Cmd+Shift+D`      | Split pane horizontally / vertically           |
| `Cmd+Shift+←↑→↓`             | Focus neighbour pane                           |
| `Cmd+P`                      | Pane palette with search                       |
| `Cmd+Shift+A`                | Agent palette (running agents only)            |
| `Cmd+Shift+O`                | Agent Mission Control                          |
| `Cmd+Shift+F`                | Command timeline                               |
| `Cmd+F`                      | Search within pane                             |
| `Cmd+G` / `Cmd+Shift+G`      | Next / previous match                          |
| `Cmd+Shift+B`                | Toggle broadcast input                         |
| `Cmd+=` / `Cmd+-` / `Cmd+0`  | Font zoom in / out / reset                     |
| `Cmd+K`                      | Clear active pane                              |
| Double-click on tab label    | Rename tab                                     |

## Agent hooks

See [`HOOKS.md`](./HOOKS.md) for setup. Short version:

```json
// ~/.claude/settings.json
{ "hooks": { "Stop": "napkin hook waiting --agent claude" } }
```

## Configuration

napkin reads `~/.config/napkin/config.toml` (or
`$XDG_CONFIG_HOME/napkin/config.toml`) at startup and watches it for
changes — themes, fonts, keybindings, and notification rules re-apply the
moment you save. Everything is optional; unknown keys are ignored.

```toml
[shell]
program = "/opt/homebrew/bin/fish"

[terminal]
font_family  = "JetBrainsMono Nerd Font"
font_size    = 15
cursor_style = "block"

[keybindings]
command_palette = "Cmd+Shift+Space"

[tabs.color_by_command]
claude = "amber"
cargo  = "red"
```

Quick access:

```
napkin config          # opens the file in $EDITOR (creates it on first run)
napkin config path     # prints the resolved path
napkin config validate # parses the file and reports syntax errors
```

Or from the command palette (⌘⇧P): "napkin: Open config…".

The full reference — every key, type, default, and the list of recognized
keybinding actions — is in [CONFIG.md](./CONFIG.md).

The font size set via `Cmd+=` / `Cmd+-` persists per-user in localStorage and
overrides the config value until you run "Font: reset" (⌘0).

## Install

**macOS, Apple Silicon or Intel** — once the first release is cut, grab the
`.dmg` from the [releases page](https://github.com/johndockery/napkin/releases/latest).

```sh
# Homebrew (requires the tap to be published)
brew install napkin-term/napkin/napkin

# One-line installer
curl -fsSL https://napkin.world/install | sh
```

**Linux (x86_64)** — same release page produces `.deb` and `.AppImage`.

```sh
curl -fsSL https://napkin.world/install | sh
systemctl --user enable --now napkind   # optional: start napkind at login
```

> **Codesigning status:** current pre-signing builds are unsigned. macOS will
> gatekeep on first launch; right-click the app in Finder → **Open** the
> first time. A signed + notarized build is the next milestone.

## Building from source

Prerequisites: Rust stable (1.77+), Node 20+, and one of `bun` / `pnpm` /
`npm`. On macOS, Xcode Command Line Tools.

```sh
git clone https://github.com/johndockery/napkin
cd napkin
bun install
bun run tauri dev            # dev build with HMR
bun run tauri build          # release .app
```

The workspace layout:

```
napkin/
├── Cargo.toml                (workspace root)
├── src-tauri/                Tauri app (thin socket client)
├── crates/
│   ├── napkin-proto/         wire types shared between daemon and clients
│   ├── napkind/              PTY-owning daemon (unix socket server)
│   └── napkin-cli/           the `napkin` binary (hooks and future CLI)
├── src/                      frontend (vanilla-ts + xterm.js)
│   └── app/                  focused modules (panes, tabs, ipc, …)
├── scripts/
│   ├── bundle-sidecars.sh    stages napkind + napkin into the .app
│   ├── install.sh            curl | sh installer
│   ├── homebrew/napkin.rb    Cask for the eventual tap
│   └── systemd/napkind.service Linux user-unit
├── .github/workflows/release.yml  tag-triggered release bundle
├── CHANGELOG.md              release notes
├── CONFIG.md                 user config reference
└── HOOKS.md                  agent hook reference
```

## Architectural tenets

1. **Local-first.** No cloud, no login, no telemetry.
2. **Daemon-centric.** Rust `napkind` owns PTY + session state; the UI is
   replaceable. Survives Tauri restart/crash.
3. **Out-of-band control plane.** Unix socket, capability-scoped; no
   escape-sequence remote control.
4. **Native hot path.** Parsing and (eventually) rendering never touch
   the DOM or Node in steady state.
5. **Every feature earns its place.** Each line item maps to a named
   pain point from the research that seeded the project.

## License

MIT. See [`LICENSE`](./LICENSE).
