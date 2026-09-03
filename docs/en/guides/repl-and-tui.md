# REPL and TUI

English | [简体中文](../../zh-CN/guides/repl-and-tui.md)

This guide covers hk2's two interactive front-ends — the default line REPL
and the `--tui` inline TUI — how the choice is made, keys, completion,
history, the status bar, tool cards, thinking output, and the mid-task input
box. Both front-ends run the same session, slash commands, and agent-turn
pipeline; only the rendering differs.

## Choosing a front-end

- **Line REPL (default)** — `hk2`. The classic readline prompt
  (`hk2(project|Eden/N Holy/N|model)>`), status bar, and tool cards. Works
  everywhere, including piped/non-TTY input.
- **Inline TUI** — `hk2 --tui` (or `HK2_UI=tui`). A Claude Code-style
  interface: a bordered multi-line input box pinned at the bottom, streaming
  markdown answers and tool-call cards in the terminal's native scrollback,
  a live status line, slash-command completion, and arrow-key confirmation
  modals.

Resolution order (highest first): the `--tui` flag, the `--repl` flag, then
the `HK2_UI` env var (default `repl`).

**TTY capability detection**: the TUI needs raw-mode stdin, a TTY output,
and a real `TERM`. Anything less — piped stdin, `TERM=dumb`, some CI
consoles — falls back to the REPL automatically with a notice. The TUI draws
on stderr by default; `HK2_TUI_STREAM=stdout` flips it (and the capability
check follows the actual stream).

## REPL line editing and completion

- **Live completion menu** — typing `/` + a prefix opens a completion menu
  as you type (no Tab needed): ↑↓ select, pageup/pagedown jump 5 items,
  Tab/Enter accept, Enter on a unique exact match submits, esc closes until
  the text changes. The menu is derived from the registered commands, so it
  can never drift from them.
- **Data-argument completion** — model refs, session ids, and project ids
  complete live from the registries: `/model use|set|del|set-default|
  set-phase|add-mcpserver <ref>`, `/session resume|info <id>`,
  `/resume <id>`, `/project set current|drop <id>`. `/model set-phase
  --phase=` completes the phase enum. `HK2_REPL_HINTS=0` restores the plain
  prompt without hints.
- **Tab** accepts the highlighted completion; plain readline editing
  (history, cursor movement) behaves as usual.
- **Multi-line input** — paste multi-line text directly (submitted as one
  message), or end a line with `\` to continue manually.

## TUI keys

| Key | Action |
|---|---|
| enter | Send the message (empty input is a no-op) |
| `\` + enter | Continue on a new line instead of sending (slash commands submit anyway) |
| alt+enter / ctrl+j | Insert a real newline |
| ↑ / ↓ | History (single line) or move one wrapped row |
| ← / →, home / end, ctrl+a / ctrl+e | Cursor movement |
| ctrl+k / ctrl+u / ctrl+w / alt+backspace | Kill to line end / line start / word before cursor |
| Tab | Accept the highlighted slash completion |
| ctrl+r | Incremental history search: type a substring, ↑↓ (or repeat ctrl+r) cycle matches, enter picks one INTO the box, esc closes |
| esc / ctrl+g | While a turn runs: interrupt it. Otherwise: close the completion menu / cancel the open modal |
| ctrl+l | Clear the screen (transcript stays in the scrollback) |
| ctrl+o | Expand the most recent tool result into the transcript (the compact line shows one line + "+N lines") |
| ctrl+c | Clear the input; if empty and a turn is running, abort it; if empty and idle, press twice consecutively to exit (any other key re-arms the window) |
| ctrl+d | Exit on an empty buffer (forward-delete otherwise) |

## Responsive layout and the welcome card

The interface adapts to the terminal: wide terminals (≥ 88 cols) get the
full welcome card with the tips panel, 60–87 cols a compact single-column
card, and narrower ones a two-line summary — nothing ever wraps past the
terminal edge. Returning users (and screens shorter than 30 rows) always get
the compact form; `/clear` prints a one-line session summary instead of
redrawing the whole card.

`HK2_WELCOME` picks the tier: `auto` (default — full on first run, compact
for returning users / short screens), `full` (force the logo card whenever
width allows), `compact` (skip the logo card; very narrow terminals still
get the two-line summary).

Selection in menus and modals is always marked by the `❯` glyph, never by
color alone. Modal prompts wrap their question text and show a key-hint row
(`↑↓ select · enter confirm · esc cancel · y/n/e`).

## Status bar

A status bar is pinned to the bottom of the terminal (TTY mode only):

```text
streaming │ postgres|kb|glm-5.2 │ ↑1.4k ↓120 0.1%/1.0M │ 4.2s
```

- `↑1.4k` — latest LLM call's input tokens
- `↓120` — latest LLM call's output tokens
- `0.1%` — current context usage (latest input / context window)
- `1.0M` — context window size

Updates live during streaming, tool calls, and phase transitions. When a
plan is active, a progress panel renders above it (see
[Planning and review](planning-and-review.md)).

## Tool cards and thinking output

Each tool call renders as a compact card (border color customizable via
`/theme`); `ctrl+o` expands the most recent one. Thinking output
(`reasoning_content` from reasoning models) is collapsed by default — the
TUI shows `Thought for Ns`, the REPL renders at most 9 content lines of the
`✎ thinking` window and reports how many lines were hidden. Set
`HK2_HIDE_THINKING=0` to stream the full reasoning live in both front-ends.

## Zero-setup first run

When no model is configured, `hk2 --tui` automatically imports one from
Claude Code's `~/.claude/settings.json` (the `env` block:
`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, with
`ANTHROPIC_DEFAULT_*_MODEL` as the model list). A notice line under the
welcome card reports the import. Fill-only — an existing default is never
overwritten; `HK2_AUTOIMPORT_CLAUDE=0` disables it. See
[Models, projects, and sessions](models-projects-and-sessions.md).

Chat still requires an initialized project: hk2 is KB-driven, so until
`/project init` + `/kb init` have run, messages are refused with a setup
pointer — even when the first-run import already configured a model.

## Typing while a task runs

While a task runs, a one-line input box (`» add instruction ▏`) is pinned
just above the plan panel / status bar, and the real terminal cursor is
docked inside the box — a blinking caret sits exactly where your typing will
land (and follows mid-text edits). What you type is echoed there; the
streaming agent output above can never disturb your in-progress text.

- **Plain text** entered mid-task is queued (echoed as
  `✓ queued #N · delivered after the current action`) and injected into the
  running conversation at the agent loop's round boundary — after the
  current action (the LLM call plus all of its tool calls) completes, before
  the next LLM call starts. The model receives it as in-task guidance
  ("fold into the work in progress, do not restart from scratch"), so the
  current action is never disturbed.
- **Slash commands** keep the legacy behavior — they run after the turn
  ends, since they may switch model / KB / project state the in-flight turn
  still depends on. Plan-confirmation menus are unaffected.
- If the task finishes before a queued instruction can be delivered mid-run,
  it is handed to a fresh turn right after — nothing you type is lost.

## Input history and its permissions

Input history persists at `~/.hk2/history.jsonl` (capped at 1000 entries).
Two safety properties of that history and the config storage:

- Inputs carrying credentials (`--api-key=…`, `--token=…`, `Authorization`
  headers, `password=`/`secret=` values) are never persisted at all.
- `~/.hk2/history.jsonl` and `models.json` are kept owner-only (0600,
  migrated on boot; `~/.hk2` itself is 0700).

## Related documentation

- [Slash commands](../reference/slash-commands.md) — the command reference
- [Planning and review](planning-and-review.md) — the progress panel shown above the status bar
- [Troubleshooting](troubleshooting.md) — TUI fallback and terminal issues
