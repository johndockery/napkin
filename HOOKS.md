# Agent hooks

napkin can infer what your shell and agents are doing from OSC 133
escape sequences, but agents that expose lifecycle hooks can do better:
tell napkin *exactly* when they start thinking, finish, or need your
attention. The pane then pulses yellow instead of orange, and a
background window fires an OS notification only when it's truly worth
interrupting you.

## What napkin exposes inside every pane

When napkind spawns a shell, it puts two env vars in that shell's
environment:

- `NAPKIN_SESSION_ID` — the session the shell is running in
- `NAPKIN_SOCKET` — the path to the daemon's unix socket

It also prepends the directory containing its own binary to `PATH`, so
the `napkin` CLI is always in reach.

You do not need to read either env var yourself. Use the CLI:

```
napkin hook <state> [--agent <name>]
```

Recognised `<state>` values (anything else collapses to `idle`):

| state                                  | UI behavior                          |
| -------------------------------------- | ------------------------------------ |
| `working` / `running` / `thinking`     | orange pulse on the tab              |
| `waiting` / `waiting_input` / `needs_input` | yellow pulse + background OS notification |
| `done` / `ok` / `completed`            | brief green flash, then idle         |
| `error` / `errored` / `failed`         | brief red flash, then idle           |
| `idle` / unknown                       | no indicator                         |

`--agent <name>` is optional and tags the pane with an agent badge.
Known agents render in their brand colour: `claude`, `codex`, `cursor`,
`aider`, `gemini`, `opencode`.

## Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": "napkin hook waiting --agent claude",
    "PreToolUse": "napkin hook working --agent claude",
    "UserPromptSubmit": "napkin hook working --agent claude"
  }
}
```

`Stop` fires whenever Claude finishes a turn — exactly when napkin
should light up yellow to say "come back". The other two keep the
orange pulse alive while Claude is mid-task.

## Anything with a shell command on completion

If your agent exposes *some* way to run a command when it finishes —
cron-style hooks, lifecycle scripts, wrapper invocations — point it at
the CLI:

```bash
my-agent --on-done 'napkin hook waiting'
```

## Writing hooks without the CLI

The CLI is a thin convenience over a one-line JSON write to the socket:

```bash
printf '%s\n' '{"op":"agent_state","session_id":"'"$NAPKIN_SESSION_ID"'","state":"waiting","agent":"my-thing"}' \
  | socat - "UNIX-CONNECT:$NAPKIN_SOCKET"
```

That lets you call in from any language without the napkin binary on
`PATH`. Same wire format, same behaviour.
