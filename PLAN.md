# napkin — plan

A living roadmap. Original research and positioning are in
[`LANDING.md`](./LANDING.md). This file tracks what's done, what's up next,
and what's deliberately out of scope.

---

## Status

### v0 (spike) — done
Tauri 2 + vanilla-ts + xterm.js scaffold, PTY plumbing, custom window chrome,
zsh running in a window.

### v1 (tmux-like workspace) — done
Pane splits with drag-resize and keyboard nav; tabs with rename, drag-reorder,
and broadcast input; OSC 133 shell integration for zsh, bash, and fish;
`napkind` daemon with session restore and scrollback replay; `napkin` CLI
(`hook` / `list` / `attach`); config file at `~/.config/napkin/config.json`;
clean module layout across four crates.

### v2 (agent-awareness edge) — done
Per-pane run-state driven by OSC 133; agent detection from command names;
explicit agent hooks via `napkin hook`; agent palette, pane palette,
command palette, help overlay, pane-local search; OS notifications when a
background pane transitions to waiting or finishes; inline image protocol
(Sixel + iTerm2); clickable file paths that open in `$EDITOR`.

### Refactor pass — done
Module split across frontend (`src/app/`) and Tauri (`src-tauri/src/`);
poisoned-lock-tolerant helpers; visible debug-overlay replaced with toast +
console reporter; `cargo fmt` clean.

### Docs — done
`README.md`, `HOOKS.md`, this file, `LANDING.md`, `LICENSE` (MIT).

---

## Milestone M1 — `v0.1.0` release (ship-readiness)

**Goal.** Turn the dev build into a thing a stranger can install in under a
minute. No more "it works on my machine" disclaimers.

**Acceptance.** A public GitHub release tagged `v0.1.0`, carrying a signed +
notarised `.dmg`, linked from the README, with a 15-second demo clip above
the fold.

**Tasks.**

1. **Release-build verification.** `bun run tauri build` produces a working
   `.app`. Launch it from `/Applications`, confirm panes / tabs / agent badge
   / session restore work end-to-end. Catch anything that only works in dev
   (e.g. `napkind` path resolution against `target/debug`).
2. **Bundle the sibling binaries.** `napkind` and the `napkin` CLI must land
   inside the bundle's `Resources` so `find_napkind()` and the PATH
   prepending continue to work after install. `tauri.conf.json` gets a
   `bundle.externalBin` list.
3. **Info.plist metadata.** `NSSupportsSuddenTermination`, correct min macOS
   version, bundle version string from `Cargo.toml`, human-readable
   `CFBundleName`, copyright line.
4. **Codesign + notarize.** Needs an Apple Developer account. Wire
   `APPLE_CERTIFICATE` / `APPLE_ID` / `APPLE_PASSWORD` as GitHub secrets.
   Until then, ship an unsigned `.dmg` with a note in the README about
   right-clicking → Open.
5. **GitHub Actions.** One workflow, triggers on `v*` tags. Runs on
   `macos-latest`, builds the `.dmg`, uploads as a release asset.
6. **Demo clip.** 15 seconds: new window, split pane, spawn Claude in one,
   watch the agent badge + waiting pulse + OS notification. Export as
   `docs/napkin-demo.gif`, embed in the README hero.
7. **Release notes.** A short `CHANGELOG.md` opened with the v0.1.0 entry;
   reproduces the highlights from this section.
8. **Cut the tag.** `git tag v0.1.0 && git push --tags`. The workflow
   uploads the asset; `gh release edit` adds the body copy.

---

## Milestone M2 — `v0.2.0` MCP server (differentiator)

**Goal.** Every competing terminal either ignores agents or wraps them.
napkin can let agents *drive* it: list panes, read output, inject keystrokes,
spawn siblings, report their own state. No other terminal exposes this.

**Acceptance.** `napkin mcp` starts a stdio MCP server. Dropping one line
into `~/.claude/settings.json` gives Claude Code tools to see and control
every napkin pane on the machine.

**Tasks.**

1. **napkind read surface.** Add `ClientOp::PaneSnapshot { session_id }` +
   `ClientOp::PaneList` that return the scrollback ring and metadata. The
   subscriber fan-out already exists.
2. **napkind write surface.** `ClientOp::Spawn` already works; add a
   pane-layout hint (parent session id + split direction) so MCP clients
   can position new panes relative to existing ones.
3. **`napkin mcp` subcommand.** Thin MCP server on stdio. Tools:
   `list_panes`, `pane_read`, `pane_write`, `pane_spawn`, `set_status`.
   Resources: `pane://active`, `pane://<session_id>` returning recent
   scrollback as text.
4. **Capability model.** MCP sessions are auth-less via the socket (anyone
   on the machine gets in today). Before shipping: require a
   `NAPKIN_MCP_TOKEN` that the user exports and the MCP client supplies.
5. **`MCP.md`.** How to wire napkin's MCP server into Claude Code, Cursor,
   and anything else with MCP support. Worked example.

---

## Milestone M3 — v2.x rounds (small wins)

Ordered by user impact per hour of work.

1. **Global scrollback search** (`Cmd+Shift+F`). Searches every pane's
   scrollback in the active tab, jumps to the match in the source pane.
2. **Per-tab color picker.** Right-click a tab → swatch menu → subtle tint.
   Ghostty wishlist item; cheap; disambiguates prod / staging / local tabs.
3. **`napkin new-tab <cwd>` / `napkin split`.** CLI entry points that talk
   to napkind over the socket and tell the active UI to open a new pane.
   Makes napkin scriptable from project-level shell aliases.
4. **Settings panel UI.** A Cmd+, overlay with every key from
   `config.json` editable live; writes the file on change. Eliminates the
   "where's my config?" question.
5. **Session TTL in napkind.** When a PTY read returns EOF, mark the
   session dead; GC after 60 s unless a client is still subscribed. Keeps
   `napkin list` honest.
6. **`@xterm/addon-image` validation.** Verify inline images actually
   render for a few real commands (`img2sixel`, `chafa`, `icat`). Drop the
   addon if it's silently broken.

---

## Milestone M4 — v3 features (quarters, not weeks)

1. **`napkin ssh <host>`.** Spawn `napkind` on the remote, tunnel the unix
   socket over an ssh `-L` session, attach from the local UI. Ships our
   terminfo entry on first connect. Closes the tmux-over-ssh gap.
2. **Devcontainer / docker-exec panes.** `container: <name>` as a pane
   attribute; napkind `exec`s into the container instead of spawning a
   login shell. Switch without a command-line ritual.
3. **Kitty graphics protocol.** Upstream `@xterm/addon-image` covers Sixel
   and iTerm2; Kitty's is what Ghostty / WezTerm / Konsole standardised on.
   Either fork the addon or add it behind a feature flag.
4. **wgpu-native renderer.** Replace xterm.js with a Rust VT parser (fork
   `alacritty_terminal`) + wgpu surface exposed through a native Tauri
   window. Target 120fps, <10ms input latency. Biggest lift on the list;
   unlocks "Electron-perf without the reputation baggage" honestly.
5. **Windows support.** Deferred deliberately during v1/v2 because every
   feature we shipped was macOS-tested. Revisit once everything else is in
   and we have someone who lives on Windows.
6. **Collab (optional, local-first).** Read-only session observe over
   Tailscale or ssh. Never mandatory, never a cloud login.

---

## Ongoing quality

These are continuous; they get picked up alongside the milestones above.

- **Tests.** Unit tests on the OSC scanner, agent classifier, layout tree
  operations; integration test that spins a fake daemon + fake client and
  replays a recorded session.
- **`CONFIG.md`.** Every key in `config.json` with defaults, types, and
  worked examples. Link from the README.
- **Error paths.** Today a daemon crash leaves the UI in a zombie state.
  Detect EOF on the client's read socket and either auto-reconnect or show
  a recoverable error.
- **Accessibility.** Tab stop / focus order in palettes; ARIA labels; a
  pass in VoiceOver.
- **Code hygiene.** No `Mutex::lock().unwrap()` reappearing during reviews;
  doc comments on every public Rust item in `napkin-proto`.

---

## Ecosystem (not on the critical path, but on the map)

- **`napkin-vscode`.** VS Code extension that uses the same daemon for VS
  Code's integrated terminal. Share one scrollback ring between editor and
  terminal app.
- **Public `napkin-proto` crate.** Publish to crates.io so third-party hook
  scripts can link the types directly instead of hand-rolling JSON.
- **MCP package.** Public npm/pip package that wraps the MCP server for
  folks who want napkin integration without a working Rust toolchain.

---

## Out of scope (deliberately)

Repeating from before so nobody drifts:

- AI as the core product identity (Warp's position).
- Mandatory account, login, or cloud backend.
- Telemetry of command history by default.
- Closed-source core.

---

## Architectural tenets (unchanged)

1. **Local-first.** No mandatory cloud; all data on device.
2. **Daemon-centric.** `napkind` owns PTY + session state; UI is disposable.
3. **Out-of-band control plane.** Unix socket + capability tokens; never
   escape-sequence remote control.
4. **Native hot path.** VT parsing and (once v3 lands) rendering never
   touch the DOM or Node in steady state.
5. **Discoverable defaults.** Zero-config for 90%; power-user config
   layered on top.
6. **Every feature earns its place.** Each shipped feature maps to a named
   pain point from the research. No novelty.

---

## Next three PRs (as of this update)

1. **M1 step 1–2.** Release-build verification + bundling napkind and
   napkin CLI into the `.app` via `externalBin`.
2. **M1 step 5.** GitHub Actions workflow that builds the `.dmg` on
   tag push.
3. **M1 step 6–8.** Demo clip, changelog, cut `v0.1.0`.

After `v0.1.0` is out, M2 (MCP server) is the next one to pick up.
