# napkin configuration

napkin reads a single TOML file at startup and applies it live:

```
~/.config/napkin/config.toml
```

(`$XDG_CONFIG_HOME/napkin/config.toml` if set.)

The file is optional — every key has a default. Unknown keys are ignored, so
forward-compat is safe. Edits are picked up **without restarting** via a
file watcher; themes, fonts, keybindings, and notification rules re-apply as
soon as the file is saved.

## Getting started

```
napkin config           # opens the file in $EDITOR, creating it first if needed
napkin config path      # prints the resolved path
napkin config init      # writes the annotated template if no file exists
napkin config validate  # parses the file and reports syntax errors
```

You can also trigger the same actions from the command palette (⌘⇧P →
"napkin: Open config…", "Reload config", "Reset config to defaults").

## Schema

### `[shell]`

| key       | type         | default                | notes                              |
|-----------|--------------|------------------------|------------------------------------|
| `program` | string       | `$SHELL`               | absolute path recommended          |
| `args`    | `[string]`   | `[]`                   | appended after napkin's shim flags |
| `env`     | `{str:str}`  | `{}`                   | overlaid on the inherited env      |
| `cwd`     | string       | `$HOME`                | `~` expansion supported            |

### `[window]`

| key       | type    | default | notes                              |
|-----------|---------|---------|------------------------------------|
| `opacity` | 0.0–1.0 | `1.0`   | applied to the whole app body      |
| `blur`    | bool    | `true`  | macOS vibrancy behind the window   |
| `padding` | int px  | `8`     | space around terminal content      |

### `[terminal]`

| key              | type              | default                                  |
|------------------|-------------------|------------------------------------------|
| `font_family`    | string            | `"JetBrains Mono, SF Mono, Menlo, monospace"` |
| `font_size`      | 9–28 int          | `14`                                     |
| `line_height`    | 0.8–3 float       | `1.35`                                   |
| `letter_spacing` | em                | `0`                                      |
| `cursor_style`   | `block`/`bar`/`underline` | `bar`                           |
| `cursor_blink`   | bool              | `true`                                   |
| `scrollback`     | int               | `10000`                                  |
| `bell`           | `none`/`visual`/`sound` | `none`                             |
| `copy_on_select` | bool              | `false`                                  |

### `[terminal.theme]`

All color keys accept CSS strings (`"#rrggbb"`, `"rgba(...)"`). Defaults come
from napkin's built-in dark palette.

`background`, `foreground`, `cursor`, `cursor_accent`,
`selection_background`, `selection_foreground`,
`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`,
`bright_black`, `bright_red`, `bright_green`, `bright_yellow`, `bright_blue`,
`bright_magenta`, `bright_cyan`, `bright_white`.

### `[tabs.color_by_command]`

Maps a command name (matched against the foreground program napkin classified
as an agent, e.g. `claude`, `codex`) to a tab tint. Only applied when the
user hasn't already picked a manual color for the tab.

Allowed colors: `red`, `amber`, `green`, `teal`, `blue`, `purple`, `pink`.

```toml
[tabs.color_by_command]
claude = "amber"
codex  = "purple"
cargo  = "red"
```

### `[agents]`

| key               | type       | default              | notes |
|-------------------|------------|----------------------|-------|
| `detect`          | bool       | `true`               | classify foreground commands as agents |
| `notify_on`       | `[string]` | `["waiting","error"]` | OS notifications when the window is unfocused |
| `cost_budget_usd` | float      | `0.0`                | 0 disables |

`notify_on` accepts any of `working`, `waiting`, `done`, `error`, `idle`.

### `[keybindings]`

Each action accepts a shortcut string like `"Cmd+Shift+P"`, `"Ctrl+]"`,
`"Cmd+ArrowUp"`. Modifier order is flexible; values are case-insensitive.
Set a value to `""` to disable the default binding.

Recognized actions:

`new_tab`, `close_pane`, `split_horizontal`, `split_vertical`, `clear_pane`,
`broadcast`, `agent_palette`, `pane_palette`, `command_palette`, `find`,
`history`, `find_next`, `find_previous`, `toggle_help`,
`jump_to_waiting_agent`, `jump_prompt_previous`, `jump_prompt_next`,
`add_bookmark`, `write_lock`, `font_bigger`, `font_smaller`, `font_reset`,
`navigate_left`, `navigate_right`, `navigate_up`, `navigate_down`,
`previous_tab`, `next_tab`.

```toml
[keybindings]
command_palette = "Cmd+Shift+Space"
broadcast       = ""                 # disable the default Cmd+Shift+B
```

### `[integrations]`

| key         | type    | default | notes |
|-------------|---------|---------|-------|
| `editor`    | string  | `$EDITOR` | override for file-link "open in editor" |
| `diff_tool` | string  | unset   | reserved for `napkin diff` front-end   |

## Example

```toml
[shell]
program = "/opt/homebrew/bin/fish"
args    = ["-l"]

[window]
opacity = 0.96
padding = 10

[terminal]
font_family  = "JetBrainsMono Nerd Font"
font_size    = 15
line_height  = 1.4
cursor_style = "block"
bell         = "visual"

[terminal.theme]
background = "rgba(10, 11, 14, 0.9)"
red        = "#ff6b6b"
green      = "#8bd17c"

[tabs.color_by_command]
claude = "amber"
cargo  = "red"

[agents]
notify_on       = ["waiting", "error", "done"]
cost_budget_usd = 5.0

[keybindings]
pane_palette    = "Cmd+K"
command_palette = "Cmd+Shift+K"
```
