# napkin

A sick, fast terminal with first-class workspaces, structured scrollback,
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
- **Agent hooks** via a small `napkin` CLI so Claude Code's `Stop` hook
  (and equivalents) can drive napkin with *exact* semantic state instead
  of inferred state
- **Background OS notifications** when an agent transitions to "waiting"
  or finishes while the window isn't focused
- **Palettes**: `Cmd+P` to jump to any pane; `Cmd+Shift+A` to filter to
  running agents
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
├── PLAN.md                   product plan and roadmap
├── HOOKS.md                  agent hook reference
└── LANDING.md                landing-page brief (for design tools)
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

See [`PLAN.md`](./PLAN.md) for the roadmap.
