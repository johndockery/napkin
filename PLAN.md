# napkin — product plan

A sick, fast terminal with first-class workspaces, structured scrollback, and
agent-awareness. Rust core + Tauri shell + wgpu renderer (eventually).

Built by merging the best ideas from tmux, Zellij, WezTerm, iTerm2, and Warp
without their respective compromises.

---

## v0 — spike (done)

- Tauri 2 scaffold, Rust backend + xterm.js frontend in a vanilla-ts Vite app
- PTY plumbing (`portable-pty`, simple reader/writer threads): `pty_spawn`,
  `pty_write`, `pty_resize`, `pty_kill` Tauri commands
- Output streamed Rust → `pty-output` event → xterm.js
- Custom window chrome: frosted-glass header, traffic-light overlay, drag
  region, orange accent, napkin icons wired through `tauri icon`
- Working zsh in the window: typing, resize, exit all correct

The spike proved the stack. Everything below is building on it.

---

## v1 — the tmux-like workspace (~2 weeks)

The single most-requested pain point across the research: tmux-grade
persistence without tmux's UX tax. v1 is that, end-to-end.

### Pane splits
- Horizontal/vertical split (`Cmd+D`, `Cmd+Shift+D`)
- Keyboard nav between panes (`Cmd+h/j/k/l` or `Cmd+Alt+Arrows`)
- Close pane (`Cmd+W`); last pane closes tab; last tab closes window
- Drag-to-resize with ratio-based layout tree (never ratio drift on window
  resize)
- Subtle focus ring on active pane

### Tabs
- Multiple tabs per window (`Cmd+T`, `Cmd+1–9`, `Cmd+Shift+[`/`]`)
- Compact tab strip in the chrome, renameable, reorderable
- Per-tab color (Ghostty wishlist item — trivial, high-value)

### Shell integration (OSC 133)
- Auto-installed zsh/bash/fish hook script that emits:
  - `OSC 133 A/B/C/D` for prompt-start / command-start / command-end /
    prompt-terminate
  - `OSC 7` for cwd
  - Exit code per command
- Rust indexes these into a per-pane command log
- `Cmd+↑` / `Cmd+↓` jump between prompt boundaries
- "Copy output of last command" — a thing no shell makes easy today

### Persistent daemon — `napkind`
The load-bearing architectural move. PTYs and session state move out of the
Tauri process into a standalone daemon speaking over a unix socket. Tauri
becomes a client.

- Daemon survives Tauri restarts and crashes
- CLI: `napkin list`, `napkin attach <session>`, `napkin kill`
- Anyone can attach from any terminal (including ssh into the same host)
- Unlocks detach/reattach, the whole reason people still use tmux

### Polish
- `~/.config/napkin/config.toml` (font, theme, keybinds, shell)
- In-app settings panel wired to the same config
- Vim-style keyboard selection mode (fixes the Zellij complaint that kept
  people on tmux)
- Broadcast input across panes with explicit opt-in and visible indicator
- macOS menu bar with the usual stuff

---

## v2 — the agent-awareness edge (~1 month)

This is the leapfrog bet. tmux was built before agents existed; every serious
dev now runs 4–10 Claude Code / Codex / Cursor / Aider panes and loses track
of which are blocked. No product has won this yet.

### Automatic agent detection
- Parse PTY output for known agent signatures (claude-code, codex, cursor,
  aider, opencode, continue, etc.)
- Infer state: `idle | thinking | waiting_input | errored | done`
- Sidebar or overlay showing all panes' states at a glance
- OS notifications on transitions (especially `waiting_input` and `errored`)

### Socket API for agents
- Agents can report their own semantic state over `napkind.sock` — no
  best-effort output scraping needed
- Agents can spawn their own sibling panes (`napkin pane spawn --role helper`)
- Agents can bookmark/label command boundaries
- Capability-scoped, out-of-band (not escape-sequence remote control — Kitty
  #2084 is the cautionary tale)

### Structured scrollback
- Each command becomes a record: `{ cmd, cwd, env, exit, duration_ms, bytes }`
- Full-text search across panes and history
- Bookmarks, pins, per-command tagging
- Export any command's output as markdown / asciinema
- iTerm2-style "instant replay" on any pane

---

## v3 — the production terminal (~2 months)

### wgpu renderer
Replace xterm.js with a Rust-native VT parser (based on `alacritty_terminal` or
custom) + wgpu rendering. Exposed to Tauri via a native surface, never through
the DOM. Target: 120fps, <10ms input latency. This is the architectural bet
that lets us honestly claim Electron-perf without the reputation baggage.

### SSH / remote
- `napkin ssh <host>` that forwards shell integration, clipboard (nested
  OSC 52 done right), and terminfo
- Ship our own terminfo and seed it on first ssh
- Remote `napkind` — run the daemon on a server, attach from the Mac UI over
  ssh tunnel

### Containers
- Devcontainer / `docker exec` / `toolbx` as a first-class pane attribute
- One-click switch between host and container context in a pane

### Collab (optional, local-first)
- Read-only session observe via encrypted socket over Tailscale/ssh
- Never mandatory cloud, never a login wall

---

## Out of scope (deliberately)

- AI as the core product identity (Warp's positioning)
- Mandatory account, login, or cloud backend
- Telemetry of command history by default
- Windows support — postponed to v4+
- Closed-source core

---

## Architectural tenets

1. **Local-first.** No mandatory cloud. All data on device.
2. **Daemon-centric.** Rust `napkind` owns PTY and session state. UI is
   disposable.
3. **Out-of-band control plane.** Unix socket + capability tokens, never
   escape-sequence remote control.
4. **Native hot path.** VT parsing and rendering never touch DOM or Node in
   steady state.
5. **Discoverable defaults.** Zero-config for 90% of users; power-user config
   layered on top.
6. **Every feature earns its place.** Each v1 line item maps to a named pain
   point from the research. No novelty features.

---

## Next three PRs

1. **Pane splits** — layout tree, focus management, keyboard nav, close logic.
2. **Tabs** — tab model in Rust, tab strip UI, keyboard shortcuts.
3. **`napkind` extraction** — move PTY ownership into a standalone daemon,
   Tauri becomes a client over unix socket. This unlocks detach/reattach,
   CLI attach, and everything in v2.

After those three land, napkin is already a more comfortable daily driver
than tmux + iTerm2 for most workflows.
