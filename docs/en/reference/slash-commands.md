# Slash commands

English | [简体中文](../../zh-CN/reference/slash-commands.md)

Complete reference for hk2's REPL/TUI slash commands. The runtime source of
truth is `src/slash/help.js` (backing `/help` and `/help <command>`) — when
editing this page, re-check it against that file and the command
implementations in `src/slash/*.js`. The latest help is always available
inside hk2 via `/help` and `/help <command>` (e.g. `/help kb`,
`/help knowledge`); every family also supports `<command> help` drilling
(e.g. `/model help set`, `/kb knowledge help learn`).

Commands are tokenized shell-style, so quoted flag values may contain
spaces: `--title="SPI Extension Pattern"`.

## Command index

| Command | Purpose |
|---|---|
| [`/model`](#model) | Manage `models.json` — providers, models, defaults, phase models, MCP servers |
| [`/project`](#project) | Manage `projects.json` — register, list, switch, rename, drop |
| [`/kb`](#kb) | KB lifecycle and queries for the current session's project |
| [`/kb knowledge`](#kb-knowledge) | Manage knowledge entries (Holy + Eden) |
| [`/kb code`](#kb-code) | Manage the permanent Supreme Code |
| [`/session`](#session) | Session management |
| [`/resume`](#resume) | Resume a previous session (Claude Code convention) |
| [`/remember`](#remember) / [`/forget`](#forget) | Record / remove session facts (compaction-immune) |
| [`/review`](#review) | Manually review the completed task |
| [`/theme`](#theme) | Customize tool-card colors |
| [`/clear`](#clear) | Clear the in-memory conversation context |
| [`/compact`](#compact) | Summarize the prior conversation |
| [`/help`](#help) | Show help |
| [`/quit` / `/exit`](#quit--exit) | Exit (same as Ctrl+D) |

## `/model`

Usage: `/model <subcommand> [args]` — manages `~/.hk2/models.json`.

| Subcommand | Effect |
|---|---|
| `list` | List all providers / models (default marked `*`) |
| `use <provider>/<model-id>` | Switch model for **this session only** (not persisted) |
| `set-default <provider>/<model-id>` | Set the global default (persisted) |
| `set-default current <provider>/<model-id>` | Set the current project's default (overrides global; `--clear` removes it) |
| `set <provider>/<model-id> [--flags]` | Modify persisted settings |
| `set-phase --phase=<name> <provider>/<model-id>` | Per-project model for one pipeline phase; `--clear` removes the override |
| `add <provider> <model-id> [--flags]` | Add a model (creates the provider if needed) |
| `add-mcpserver <provider>/<model-id> --type=<t> --name=<n> [--options=JSON]` | Attach an MCP server to an existing model |
| `del <provider>/<model-id>` | Delete a model |
| `types` | List all supported `--model-type` values |
| `show` | Show the current default model |

Flags for `set` / `add`:

| Flag | Meaning |
|---|---|
| `--api=openai\|anthropic` | Provider API dialect (provider-level) |
| `--base-url=URL` | API endpoint base URL (provider-level) |
| `--api-key=KEY` | API key (provider-level) |
| `--name=NAME` | Wire model code sent to the API |
| `--id=NEW_ID` | (`set` only) Rename the model id / ref key — the wire code is unaffected |
| `--reasoning=on\|off` | Reasoning on/off |
| `--context-window=N` | Context window size (tokens) |
| `--max-tokens=N` | Max output tokens |
| `--temperature=N` | Sampling temperature |
| `--model-type=TYPE` | Model family (see `/model types`; default `generic`) |
| `--model-options=JSON` | Model-specific options, e.g. `'{"enable_thinking":true}'`; `'{}'` clears; validated against the type's declared features |

`set-phase` phases: `rewrite-query`, `request-assess`, `plan-review`,
`code-review`.

`add-mcpserver`: `--type=http` implemented (`stdio` reserved); `--name` is
unique per model (re-adding replaces). `--options` for http:
`{"url":"...","headers":{"Authorization":"Bearer $APIKEY"}}` — `$APIKEY` is
substituted with the provider's `--api-key` at use time; the stored config
keeps the placeholder, never the key.

Examples:

```bash
/model list
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel
/model set-default current local/mymodel        # project default
/model set-default current --clear
/model set local/mymodel --temperature=0.5 --max-tokens=8192
/model set local/mymodel --id=mymodel-v2        # rename the ref key
/model set-phase --phase=rewrite-query local/mymodel
/model del local/mymodel
```

## `/project`

Usage: `/project <subcommand> [args]` — manages `~/.hk2/projects.json`.

| Subcommand | Effect |
|---|---|
| `init [--name=<name>] --source=<path> [--source-root=<rel>] [--include=...] [--exclude=...] [--extra=...]` | Register a new project (generates UUID) |
| `list` | List all projects (current marked `*`) |
| `set current <id\|name>` | Switch the current project — saves the current session under the old project and starts fresh on the target; switching to the already-current project is a no-op |
| `set name <new-name>` | Rename the current project |
| `set source <path>` | Update the source path |
| `set source-root <rel-path>` | Update the indexed sub-root |
| `set include <glob1,glob2,...>` | **Replace** the include glob set (the defaults are dropped) |
| `set exclude <glob1,glob2,...>` | **Replace** the exclude glob set (the defaults are dropped) |
| `show` | Show the current project's settings |
| `drop <id\|name>` | Remove a project's registration — **no confirmation prompt**. The KB directory survives as an orphan under the old UUID and is **not** reconnected by re-registering the same path (new UUID); see [Models, projects, and sessions](../guides/models-projects-and-sessions.md#projects) |

`init` flags: `--name` (defaults to directory name), `--source` (required),
`--source-root` (indexed sub-directory, default whole tree),
`--include`/`--exclude` (comma-separated globs that **replace** the default
sets — see
[Models, projects, and sessions](../guides/models-projects-and-sessions.md#projects)),
`--extra=<name>:<rel>,...` (named extra roots, e.g. `docs:docs,spec:spec`).

## `/kb`

Usage: `/kb <subcommand> [args]` — lifecycle and queries for the current
project's KB. Commands use the current session's project: a `--project`/`--project-id`
pin is session-local; without a pin, the shared `projects.json.current` pointer is used.

| Subcommand | Effect |
|---|---|
| `init [--full] [--checkpoint-interval=N] [--no-checkpoint] [--no-resume] [--skip-summary]` | Build the KB — **always a full re-index** in the current implementation; checkpointed and resumable; summary generation is attempted only when a model is configured and `--skip-summary` is not passed, with each non-empty success written independently |
| `update` | Incremental update (sha256 diff) of changed files — rebuilds the derived symbol indexes/graphs and **synchronizes parser-owned `doc:<relpath>` Eden entries** for indexed documents (new/changed docs written or replaced, deleted/excluded docs' parser-owned entries removed, Eden knowledge index possibly rebuilt); legacy KBs are backed up to `backup/pre-upgrade-<ts>/` then migrated (a parser-version change triggers a full re-index) |
| `status` | Per-space statistics; normally read-only, but a legacy KB missing the permanent Supreme Code entry is self-healed by writing an empty entry first |
| `search <query> [--top-k=N]` | Direct BM25 + reranking symbol search (default top-k 20; no LLM rewrite or source slices) |
| `symbol <name>` | Look up symbols by exact name |
| `neighbors <symbol_id>` | Call-graph neighbors (symbol id looks like `<fileId>:<line>`) |
| `knowledge <sub> [...]` | See [`/kb knowledge`](#kb-knowledge) |
| `code <sub> [...]` | See [`/kb code`](#kb-code) |
| `transform <id> <from> <to>` | Move an entry between holy/eden (confirmation required) |
| `drop` | Delete the whole KB (confirmation required) |

## `/kb knowledge`

Usage: `/kb knowledge <subcommand> [args]`.

| Subcommand | Effect |
|---|---|
| `list [--space=holy\|eden]` | List entries (both spaces by default) |
| `show <id>` | Show a full entry (searches both spaces) |
| `add [--space=holy\|eden] --title=<t> [--id=<id>] (--intro=<text> \| --intro-file=<path>) [--key-files=<a,b>] [--key-symbols=<a,b>] [--keywords=<a,b>]` | Manually persist an entry (default holy) |
| `learn [--space=eden\|holy] [--file=<path>] [--base-dir=<dir>] [--per-batch-chars=N] [--dry-run] [--no-survey] [--model=<provider>/<model-id>] [--plan-timeout-ms=N] [instructions...]` | Unified LLM deep-study (DOC or CODE mode) — see below |
| `housekeep <eden\|holy\|all> [--model=<provider>/<model-id>]` | LLM-assisted: broken-entry scan, duplicate/similar merge (y/N), Eden↔Holy conflict resolution (`all`, per-pair choice). Supreme-code never touched; indexes rebuilt |
| `empty <eden\|holy\|all>` | Deletes every **ordinary** entry in the selected space(s); the permanent Supreme Code entry is preserved — irreversible, always confirms y/N |
| `export <eden\|holy\|all> <path>` | Dump entries to JSON (version 2, per-entry `space` tags) |
| `import <path> [eden\|holy\|adaptive] [--overwrite]` | Import entries; `adaptive` routes each entry to its original space; Holy imports always prompt y/N |
| `del <id>` | Delete one entry (confirmation required) |

`learn` auto-selects a mode: **DOC mode** (`--file`, or `--base-dir` pointing
at documents) deep-studies Markdown / PDF / Word / PowerPoint / text files
into the chosen space (files may live outside the project); **CODE mode**
(bare, or `--base-dir` = an indexed subdirectory) deep-studies indexed
source — an optional Phase 0 survey (runs only when not `--dry-run`, no
`--base-dir`, not `--no-survey`), Phase 1 topic planning, Phase 2
extraction.
With `HK2_KB_LEARN_VALIDATE=1` (default) proposed entries are validated
against the existing KB before writing (`0` switches to the legacy
heuristic path). Flags:
`--space` (default eden; CODE mode always writes Eden), `--file`,
`--base-dir`, `--per-batch-chars` (default 100000), `--dry-run`,
`--no-survey` (skip Phase 0), `--model`, `--plan-timeout-ms` (default
300000), and free-form trailing instructions passed to every LLM prompt.
In DOC mode, the run-level confirmation applies only when the target is Holy
and `--dry-run` is not set. After it is accepted, new Holy entries do not
prompt individually; merges into or overwrites of existing Holy entries may
still prompt per entry. CODE mode always writes Eden and ignores
`--space=holy`.

Aliases: `ls`→list, `get`→show, `create`/`set`→add,
`study`/`init`/`bootstrap`/`scan`→learn,
`housekeeping`/`cleanup`/`clean`→housekeep, `clear`/`wipe`→empty, `rm`→del.

## `/kb code`

Usage: `/kb code <subcommand> [args]` — manage the Supreme Code entry
`hk2-supreme-code`. The entry can never be deleted, renamed, moved, or
auto-updated; items change only here, each write with an explicit y/N
confirmation. Limits: max 100 items, 200 characters each, numbered 1..N
gapless (`add` without an id appends as N+1; an id > N+1 is rejected).

| Subcommand | Effect |
|---|---|
| `list` | Show all items |
| `add [code-id] (--code-content=<text> \| --code-gen=<instructions>) [--model=<provider>/<model-id>]` | Add or update one item (`--code-content` writes verbatim; `--code-gen` asks a model to draft one item, sanitized and confirmed before writing) |
| `del <code-id>` | Delete one item; later items shift up |

## `/session`

Usage: `/session <subcommand> [args]`. Sessions are stored as JSONL at
`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`.

| Subcommand | Effect |
|---|---|
| `info [<sessionId>]` | Session info — current session with no id; a stored session's stats for an id (unique prefix match supported) |
| `list [--limit=N]` | Recent sessions for the current project (default 20) |
| `new` | Start a new session (fresh transcript) |
| `resume [<sessionId>]` | Resume a previous session (full context restored); with no id, the project's latest previous session |
| `compact` | Manually compact the conversation (same as `/compact`) |

## `/resume`

Usage: `/resume [<sessionId>]` — reopen a previous session's transcript and
restore the full conversation context (messages, tool-call history,
interrupted-task state). With no id: the project's latest previous session.
Equivalent to `/session resume` — Claude Code's convention.

## `/remember`

Usage: `/remember [fact] [--project|-p]` — record a session fact that, after successful persistence, stays
in scope for the whole session and survives compaction by design.

- No args — list the recorded facts.
- With a fact — persist it (max 100 facts per session, each trimmed to 500
  characters; normalized dedup). After successful persistence, the fact is
  injected into every subsequent turn via a standing `## Session facts`
  system message, refreshed live; failed or non-interactive saves are not
  recorded.
- `--project` / `-p` — additionally append the fact to the project-level
  Eden entry `env-facts` (cross-session, searchable via
  `kb_search_knowledge`; capped at 200 lines, append-deduped).
- Requires an active project session; without one it refuses cleanly.

Facts are for environment/constraints/preferences (endpoints, ports,
versions, account names — never secrets); reusable code knowledge belongs to
the KB (`kb_save_knowledge`, `/kb knowledge add`). The agent has a matching
`remember` tool and an extraction pass runs at compaction time.

## `/forget`

Usage: `/forget [substring]` — remove session facts.

- With a substring — remove every fact containing it; prints how many were
  removed and how many remain.
- No args — remove **all** facts, after a y/N confirmation.
- No match — prints the current facts list so you can pick a substring.

## `/review`

Usage: `/review <phase> [--model=<provider>/<model-id>]` — manually review
the just-completed task in this conversation.

| Phase | Status |
|---|---|
| `code` | Implemented — manual code review of the completed task |
| `plan` | Not implemented yet |

Only the original task request and the completed result (final answer +
changed files + working-tree diff) are sent to the review model — the
implementation context is ignored, so it cannot influence the review
(fresh-eyes regression check). The reviewer's analysis streams live; an
unparseable verdict is reported as UNKNOWN, never as "no issues found".
`--model` overrides the phase-configured model
(`/model set-phase --phase=code-review`), then the session model.

## `/theme`

Usage: `/theme <subcommand> [args]` — customize tool-card border/title
colors (`~/.hk2/theme.json`).

| Subcommand | Effect |
|---|---|
| `list` | List current colors vs built-in defaults (default action) |
| `set <key> <color>` | Set and persist a color |
| `reset [key]` | Drop one key, or the whole custom theme with no arg |
| `preview` | Print sample cards for the three built-in groups |
| `title-follow [on\|off]` | Toggle the top-border title following the frame color instead of the fixed muted hue |

Keys (resolution: exact tool name > group key > `*` > built-in default):
`bash` (exact tool name), `kb_*` (any `kb_`-prefixed tool), `*` (any other
tool), or an exact tool name like `read`. Colors: `#rrggbb` truecolor,
`ansi:0-255` palette, or a built-in token (`accent`, `muted`, `dim`,
`success`, `error`, `warning`, `border`, `bashMode`, `pythonMode`).

## `/clear`

Clears the current in-memory conversation context (the LLM sees a fresh
history). The session transcript on disk is preserved; use `/session list`
to browse past sessions and `/session resume <id>` to reopen one.

## `/compact`

Summarizes the prior conversation into a short brief and continues with it
in place of the full history — frees context space on long sessions.
Equivalent to `/session compact`. Auto-compact at turn boundaries is on by
default (`HK2_ENABLE_AUTOCOMPACT`); before turns are summarized away,
durable session facts are extracted first (see [`/remember`](#remember)).

## `/help`

`/help` lists all commands; `/help <command>` prints the full usage, flags,
and examples for one family. The same text is reachable as
`<command> help` (e.g. `/model help set-phase`).

## `/quit` / `/exit`

Exit the REPL. Same as Ctrl+D. `/exit` is an alias of `/quit`.

## Related documentation

- [REPL and TUI](../guides/repl-and-tui.md) — where these commands run, with completion
- [Agent tools](agent-tools.md) — what the agent (not you) can call
- [Environment variables](environment-variables.md) — flags gating related behaviors

### Status self-healing

`/kb status` normally reads and displays statistics. For an older KB missing the permanent `hk2-supreme-code` entry, it first creates an empty permanent entry, so this special case has a write-to-disk side effect. Initial `KBRuntime` loading has the same missing-entry self-heal.
