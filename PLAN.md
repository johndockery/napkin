# napkin — plan

A living roadmap. Original research and positioning are in
[`LANDING.md`](./LANDING.md). This file tracks what's done, what's up next,
and what's deliberately out of scope.

---

## Status

### v0 — done
Tauri 2 + vanilla-ts + xterm.js scaffold, PTY plumbing, custom chrome.

### v1 — done
Pane splits (drag-resize, keyboard nav, drag-reorder), tabs (rename,
broadcast input), OSC 133 for zsh / bash / fish, `napkind` daemon with
session restore and scrollback replay, `napkin` CLI (`hook` / `list` /
`attach`), config file, module-split refactor.

### v2 — done (partial)
Per-pane run-state indicator, agent detection from command names, agent
hooks via `napkin hook`, agent palette, pane palette, command palette,
help overlay, pane-local search, OS notifications, inline image protocol,
clickable file paths.

### Docs — done
`README.md`, `HOOKS.md`, this file, `LANDING.md`, `LICENSE`.

---

## Milestone M1 — `v0.1.0` = "landing-page truthful"

**The bar has moved.** We don't ship `v0.1.0` until every claim on
[napkin.html](./LANDING.md) is true, or has been explicitly dropped from
the page. Shipping a half-built product with made-up specs is exactly the
kind of thing we're trying not to do.

This milestone is broken into five phases you can do in sequence. The
phases are ordered by dependency (later ones need things earlier ones
land), not by impact.

### Phase A — quick wins (1–2 days)
Closes small, user-visible gaps with near-zero risk.

- [ ] Rebind agent palette from `Cmd+Shift+A` to `Cmd+J` and change its
  semantics from "open a palette" to "jump to the next waiting agent"
  (preserve the palette as `Cmd+Shift+A`)
- [ ] Per-tab color picker — right-click a tab → swatch row → tab.color
  tint; persisted via napkind session metadata
- [ ] `Cmd+↑` / `Cmd+↓` jump between prompt boundaries in the active pane,
  driven off the OSC 133 marks napkind already records
- [ ] Scrollback bookmarks — `Cmd+Shift+K` pins the current prompt; jump
  via a bookmark picker (reuses the palette scaffolding)
- [ ] Drop or fix the architecture pills that aren't true: "Tokio",
  "WebView2", "SQLite" until their phase lands

### Phase B — persistence layer (3–5 days)
Delivers the *"reboot, come back two days later, everything's still
there"* promise and unlocks cross-session search.

- [ ] Add SQLite to napkind for on-disk state. Schema: `sessions`,
  `commands` (cmd, cwd, started_at, ended_at, exit_code, bytes_at_start),
  `scrollback_chunks` (session_id, offset, bytes). The existing 2 MB ring
  spills to disk every ~64 KB.
- [ ] On napkind start, rebuild session index from SQLite so `napkin list`
  survives reboot. PTYs themselves don't survive (kernel drops them), but
  session *metadata* + scrollback history does.
- [ ] Global scrollback search (`Cmd+Shift+F`) — palette-style overlay
  that runs a full-text query against the commands + scrollback tables
  and jumps to the match in the source pane.
- [ ] Scrollback export — `napkin export <session>` dumps the raw bytes
  and/or a JSON record of commands.

### Phase C — agent-era features (1–2 weeks)
Everything the landing calls out under "agent fleet" and "diff preview."

- [ ] Agent sidebar per pane (optional overlay) with live token count,
  elapsed time, and cost where the hook script can emit it. Extend the
  `napkin hook` surface to accept `--tokens N` / `--cost USD` / similar
  metadata; napkind stores on the session.
- [ ] Diff preview for agents (`Cmd+Enter`) — the hook script emits a
  unified diff before apply; napkin renders it in an overlay; accept /
  reject routes back through the hook.
- [ ] Worktree-per-agent — a `napkin workspace new <branch>` CLI command
  that creates a git worktree under `~/napkin/workspaces/<branch>` and
  spawns a pane inside. Write-lock metadata attached to the session.
- [ ] Write-locks on panes — a lock flag on a session disables broadcast
  input targeting it; the lock state is visible in the chrome.
- [ ] Pause/resume agent via hook verb — `napkin hook pause` sends SIGSTOP
  to the agent's PTY group; `napkin hook resume` / `kill -CONT`.

### Phase D — remote (1–2 weeks)
The "SSH without the pain" feature on the landing page.

- [ ] Ship our own terminfo entry (`xterm-napkin`) and install it on the
  remote on first `napkin ssh`.
- [ ] `napkin ssh <host>` CLI — spawns `napkind` on the remote if missing,
  opens a unix-socket-over-ssh tunnel (`ssh -L`), and attaches a new tab
  to the remote daemon. Every other feature (splits, OSC 133, agent
  detection) works transparently.
- [ ] Nested-clipboard correctness — OSC 52 passes through to the host
  clipboard even across N `ssh` hops.

### Phase E — ship-readiness (3–5 days)
Only starts once A–D are green.

- [ ] Release build of the Tauri app with `napkind` and `napkin` CLI
  bundled into `Resources/` via `bundle.externalBin`.
- [ ] Codesign + notarize (needs an Apple Developer account). Until then,
  unsigned `.dmg` with README note.
- [ ] GitHub Actions workflow on `v*` tags, attaches `.dmg` to the
  release.
- [ ] Linux static binary + `.deb` / `.rpm` / AppImage built in the same
  workflow.
- [ ] Homebrew tap `napkin-term/homebrew-napkin` with a `napkin` formula
  pointing at the GitHub release assets.
- [ ] `curl -sSf napkin.sh/install | sh` — an install script hosted on
  GitHub Pages (or a real `napkin.sh` domain if acquired) that picks the
  right asset.
- [ ] `systemd --user` unit so napkind starts with the user session on
  Linux.
- [ ] 15-second demo clip embedded in the README hero.
- [ ] `CHANGELOG.md` opened with the `v0.1.0` entry.
- [ ] Cut the tag. Publish the release. Update the landing page `v0.4.1
  beta` string to whatever we actually tag.

---

## Milestone M2 — `v0.2.0` MCP server

Now strictly **post-ship**. Independent of the landing page; a
differentiator for the next release.

- MCP stdio server as a `napkin mcp` subcommand
- Tools: `list_panes`, `pane_read`, `pane_write`, `pane_spawn`,
  `set_status`
- Resources: `pane://active`, `pane://<session_id>`
- Capability token so the socket isn't anon-auth for MCP clients
- `MCP.md` with a worked Claude Code config

---

## Milestone M3 — bigger swings

Everything that's clearly v2+ and doesn't block the landing-page bar.

- **wgpu-native renderer** — replace xterm.js with a Rust VT parser plus
  a native surface exposed through Tauri. Target 120fps / <10ms input
  latency. Biggest code lift on the list.
- **Kitty graphics protocol** — the one image protocol
  `@xterm/addon-image` doesn't cover.
- **Windows support** — every feature so far was macOS-tested; Windows
  needs its own pass on PTYs, signals, paths, and installer.
- **Collab (optional, local-first)** — read-only session observe over
  Tailscale/ssh. Never mandatory, never a login wall.
- **nushell shell integration** — landing currently names `nu` alongside
  zsh/fish/bash. Either fold into Phase A as a fourth shim or drop from
  the landing page. **Decision: fold into Phase A.**

---

## Ongoing quality

Picked up alongside the milestones, not blocking any of them.

- **Tests.** Unit tests on the OSC scanner, agent classifier, and layout
  tree. Integration test that replays a recorded session against a fake
  daemon.
- **`CONFIG.md`.** Every key in `config.json` with defaults and worked
  examples.
- **Error paths.** Detect EOF on the client's read socket and either
  auto-reconnect or show a recoverable error (today the UI wedges).
- **Accessibility.** Focus order in palettes, ARIA labels, VoiceOver pass.
- **Code hygiene.** No `Mutex::lock().unwrap()` reappearing; doc comments
  on every public item in `napkin-proto`.

---

## Ecosystem (post-M1, on the map)

- `napkin-vscode` extension sharing the daemon with VS Code's integrated
  terminal
- Public `napkin-proto` crate on crates.io so third-party hook scripts can
  link the types directly
- MCP package on npm/pip for non-Rust integrations

---

## Out of scope

Unchanged. Here so nobody drifts.

- AI as the core product identity (Warp's position)
- Mandatory account, login, or cloud backend
- Telemetry of command history by default
- Closed-source core

---

## Architectural tenets

1. **Local-first.** No mandatory cloud; all data on device.
2. **Daemon-centric.** `napkind` owns PTY + session state; UI is
   disposable.
3. **Out-of-band control plane.** Unix socket + capability tokens; never
   escape-sequence remote control.
4. **Native hot path.** VT parsing and (once v3 lands) rendering never
   touch the DOM or Node in steady state.
5. **Discoverable defaults.** Zero-config for 90%; power-user config
   layered on top.
6. **Every feature earns its place.** Each shipped feature maps to a
   named pain point from the research. No novelty.

---

## Immediate next PRs

1. **Phase A step 1** — rebind agent shortcut to `Cmd+J` with
   jump-to-waiting-agent semantics; palette stays on `Cmd+Shift+A`.
2. **Phase A step 2** — per-tab color picker, wired to a new `Tab.color`
   in napkind session metadata.
3. **Phase A step 3** — `Cmd+↑` / `Cmd+↓` jump between OSC-133 prompt
   boundaries.

After those three, keep going through Phase A, then B, and so on.
