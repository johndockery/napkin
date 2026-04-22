# napkin — landing page brief

Paste this into v0, Lovable, Framer AI, Figma Make, or similar. It's written as
a brief, not as copy — trust the tool to generate the copy from it.

## Product

**napkin** — the terminal that actually feels like a workspace.

## One-line pitch (hero)

A fast, local-first terminal with built-in workspaces, structured
scrollback, and agent-awareness. Built in Rust.

## What it is, in one paragraph

napkin is a new terminal for developers who have outgrown tmux + iTerm2 but
don't want to live in Warp's block UI or trust a login wall for their shell.
It treats sessions, panes, command history, and cwd as first-class structured
state — not as ephemeral text. It knows when your Claude Code or Codex agent
is thinking, waiting, or done. And its Rust daemon keeps your workspace alive
when the UI quits.

## Three things it solves

1. **Workspaces that restore themselves.** Close the window, reboot, come
   back — every pane, cwd, env, and scrollback is where you left it. Detach
   and reattach just like tmux, without the keybinding gymnastics.
2. **Scrollback that behaves like real software.** Full-text search every
   command, jump between prompt boundaries, bookmark output, replay history.
   Every command is a record, not a blob of bytes.
3. **Agent-aware by design.** napkin detects when you're running Claude Code,
   Codex, Cursor, or any other agent, and tells you at a glance which ones
   need you. No more alt-tabbing across six panes.

## Six features for the grid

- **Pane splits & tabs** — fast, keyboard-first, drag-to-resize, per-tab
  color.
- **OSC 133 shell integration** — prompt boundaries, exit codes, cwd tracking
  baked in.
- **Persistent daemon (`napkind`)** — your workspace outlives the UI.
- **Broadcast input with safe scoping** — operate across SSH sessions or repos
  with a visible indicator so you never accidentally `rm -rf` everywhere.
- **SSH that actually works** — ships its own terminfo, clipboard passes
  through nested sessions cleanly, no more `xterm-ghostty` errors on servers.
- **No cloud, no login, no telemetry.** Ever.

## Target audience

Senior engineers who run 6+ terminal panes across local / remote / container
contexts. Currently using tmux + iTerm2 or WezTerm and frustrated with both.
Running AI coding agents they want to manage as first-class citizens.

## Tone

Confident. Technical. Understated. No AI hype, no "revolutionary",
no emoji. Closer to **Linear / Ghostty / Arc / Tailscale** than Warp.
Say what it does, show it running, get out of the way.

## Visual direction

- Dark mode default with a warm orange accent (`#f5a742`)
- Monospace type (`JetBrains Mono`, `SF Mono`)
- Lots of real terminal screenshots and one or two short looping videos of
  actual workflows (pane splits, agent sidebar, detach/reattach)
- No gradients, no glassmorphism beyond a subtle top bar, no stock
  illustrations, no "AI magic" language
- Show, don't tell — a 15-second loop of multiplexed panes beats any
  marketing paragraph

## Page sections (in order)

1. **Hero** — product name, one-line pitch, primary CTA, background is a
   live terminal gif/video (not a static screenshot)
2. **Why napkin** — the three pain points above, one short paragraph each
3. **Feature grid** — six features, icon + one sentence each
4. **Architecture diagram** — three boxes: Rust core, `napkind` daemon, Tauri
   UI; arrows for IPC; caption emphasizes "UI is disposable, daemon owns
   state"
5. **Quickstart** — `brew install napkin` or download `.dmg`, plus a
   build-from-source link for Rust people
6. **Footer** — GitHub, changelog, plan doc, license (MIT)

## CTAs

- Primary: **Download napkin**
- Secondary: **Read the plan** (links to PLAN.md on GitHub)
- Tertiary: **Star on GitHub**

## Anti-CTAs (do not put these on the page)

- "Sign up" / email capture
- "Try AI for free"
- "Book a demo"
- Login prompt

## Palette

- Background: `#0b0c0f`
- Surface: `#121318`
- Foreground: `#e6e6e6`
- Dim: `#8a8f98`
- Accent: `#f5a742`
- Border: `rgba(255, 255, 255, 0.06)`

## Do-not-do list

- Do not compare napkin to "an AI terminal." It's a workspace-first terminal
  that happens to understand agents.
- Do not imply it requires or encourages an account.
- Do not put the word "revolutionary" anywhere on the page.
