# Models, projects, and sessions

English | [简体中文](../../zh-CN/guides/models-projects-and-sessions.md)

This guide explains the three registries that shape an hk2 session: the
multi-provider model registry (`models.json`), the project registry
(`projects.json`), and session transcripts — plus phase models, the Claude
Code first-run import, and MCP servers. For the exact flag reference see
[Slash commands](../reference/slash-commands.md); for the file layout see
[Configuration](../reference/configuration.md).

## Providers and models

A **provider** is an endpoint: an API dialect (`openai` or `anthropic`), a
base URL, and an API key. A **model** is an entry under a provider with its
own tuning. References always use the form `<provider>/<model-id>`, e.g.
`local/mymodel`.

- hk2 speaks two API dialects: the OpenAI-compatible chat-completions
  protocol (`--api=openai`, the common choice for self-hosted gateways) and
  the Anthropic messages protocol (`--api=anthropic`).
- One install manages unlimited providers and models.

### `id` vs `name`

Each model has an `id` and a `name`:

- `id` — the accounting key used in `provider/id` refs; may carry a trailing
  bracketed context-window hint such as `[1m]`.
- `name` — the wire model code actually **sent in the API request body**
  (the request's `model` field). Set it to the exact string the provider
  expects (e.g. `mymodel`, never `MY MODEL`).

Keeping the hint on `id` and the clean code on `name` avoids
"model code does not exist" errors on gateways that reject a `model` value
like `mymodel[1m]`. `/model set --id=NEW_ID` renames the ref key only — the
wire `name` is unaffected.

### Default resolution order

1. **Session model** — `/model use <ref>` (this session only, not persisted)
2. **Project default** — `/model set-default current <ref>` (overrides the
   global default for that project; `--clear` removes it)
3. **Global default** — `/model set-default <ref>` (persisted in
   `models.json`)

## Configuring models

```text
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example --context-window=128000
/model set-default local/mymodel
/model list
/model show
```

Common flags (full list in [Slash commands](../reference/slash-commands.md)):

| Flag | Meaning |
|---|---|
| `--api=openai\|anthropic` | Provider API dialect (provider-level) |
| `--base-url=URL` | API endpoint base URL (provider-level) |
| `--api-key=KEY` | API key (provider-level) |
| `--name=NAME` | Wire model code sent to the API |
| `--reasoning=on\|off` | Enable/disable reasoning |
| `--context-window=N` | Context window size (tokens) |
| `--max-tokens=N` | Max output tokens |
| `--temperature=N` | Sampling temperature |
| `--model-type=TYPE` | Model family (`/model types` lists all values) |
| `--model-options=JSON` | Model-specific options, e.g. `'{"enable_thinking":true}'` |

`--model-type` declares the model family so hk2 can apply family-specific
behavior. Types with declared features validate `--model-options` — e.g.
`--model-type=glm-5.3` (and `glm-5.3-flash`) accepts
`{"reasoning_effort":"max"}` with max (deep reasoning) the default and
recommended, or high (enhanced) / low (light). Unlisted types fall back to
`generic`.

As an alternative to manual entry, setting `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in the environment auto-creates a matching provider on
first init.

## Phase models

Four pipeline phases can use a different model than the session model, per
project:

| Phase | Runs |
|---|---|
| `rewrite-query` | Query rewrite before BM25 retrieval |
| `request-assess` | Request-clarity assessment |
| `plan-review` | Review of a confirmed plan (`HK2_ENABLE_PLANREVIEW=1`) |
| `code-review` | Review of the completed task (`HK2_ENABLE_CODEREVIEW=1` and `/review code`) |

```text
/model set-phase --phase=rewrite-query local/mymodel
/model set-phase --phase=code-review --clear
```

When unset, a phase uses the session model. If a configured phase model is
unreachable, `HK2_ENABLE_PHASEMODEL_FALLBACK` decides between re-running the
phase on the session model (default) or skipping it — the review phases
always skip rather than silently substitute a different reviewer. See
[Planning and review](planning-and-review.md).

## Claude Code first-run import

When no model is configured, `hk2 --tui` automatically imports one from
Claude Code's `~/.claude/settings.json` — the `env` block's
`ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, with
`ANTHROPIC_DEFAULT_*_MODEL` as the model list. A notice line under the
welcome card reports the import.

- **Fill-only** — an existing default is never overwritten.
- **Idempotent** — a second boot with no Claude config is a no-op.
- **Kill switch** — `HK2_AUTOIMPORT_CLAUDE=0` disables the import.

The Anthropic adapter sends both `x-api-key` and `Authorization: Bearer`, so
`ANTHROPIC_AUTH_TOKEN`-style gateways authenticate unchanged.

## MCP servers

Attach Model Context Protocol servers to a model; their tools then appear to
the agent as `mcp__<name>__<tool>`:

```text
/model add-mcpserver local/mymodel --type=http --name=web-reader \
  --options='{"url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer $APIKEY"}}'
```

- `--type=http` is implemented; `stdio` is reserved.
- `--name` is unique per model; re-adding the same name replaces the server.
- `$APIKEY` in options is substituted with the provider's `--api-key` at
  **use time** — the stored config keeps the placeholder, never the key.
- Each agent turn attaches MCP tools after the built-ins; unreachable
  servers are skipped with a warning.

## Projects

Projects are registered in `~/.hk2/projects.json` with a generated UUID; the
`current` pointer names the active one.

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
/project list
/project set current <id|name>
/project set name new-name
/project set source /new/path
/project set source-root src
/project set include '**/*.sql'
/project set exclude 'vendor/**'
/project show
/project drop myapp
```

Registration options (`/project init`):

| Flag | Meaning |
|---|---|
| `--name=<name>` | Display name (defaults to directory name) |
| `--source=<path>` | Source path (required) |
| `--source-root=<rel>` | Indexed sub-directory (e.g. `src`); default = whole tree |
| `--include=<globs>` | Comma-separated include globs — **replaces the whole default set** (see the warning below) |
| `--exclude=<globs>` | Comma-separated exclude globs — **replaces the whole default set** (see the warning below) |
| `--extra=<name>:<rel>,...` | Named extra roots, e.g. `docs:docs,spec:spec` |

- **`sourceRoot` / `extraRoots`** — the indexed roots of the project. The
  main source root plus any named extra roots all get walked by `/kb init`.
- **include/exclude globs — full replacement, not extension.** Passing
  either one replaces the entire default glob list for that project
  (`/project set include` / `set exclude` likewise overwrite the stored
  array). `/project init --include=**/*.cs` therefore scans *only* `.cs`
  files, and `/project set exclude vendor/**` silently drops the default
  `node_modules` / `.git` / build excludes. To add extensions, copy the
  defaults from [Configuration](../reference/configuration.md) and append.
- **Switching** — `/project set current` saves the current session under the
  old project and starts a fresh session on the target (equivalent to
  `/quit` then `hk2 --project=<target>`); switching to the already-current
  project is a no-op.
- **`/project drop`** removes the registration **without a confirmation
  prompt**. The KB directory stays on disk, but under the project's UUID —
  since `/project init` generates a **new UUID** each time, re-registering
  the same path does **not** reconnect the old KB; it starts a fresh one.
  The old directory remains as an orphan under `~/.hk2/kb/<old-uuid>/`
  (delete it manually if you want). Reusing an old KB currently requires
  restoring the original project record with its UUID; there is no CLI
  command for that yet.

The same registration is available from the shell:
`hk2 --mode=project-init --name=myapp --source=/path/to/repo`.

## Sessions

Sessions are stored as JSONL transcripts at
`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`.

```text
/session info
/session list --limit=5
/session new
/session resume            # latest previous session
/session resume 3f9c1a2e   # by id (unique prefix match)
/compact                   # summarize prior conversation
```

- `hk2 --resume` (optionally `--resume <id>`) reopens a session at launch,
  restoring the full conversation context, tool-call history, and
  interrupted-task state. Combine with `--project`/`--project-id` to resume
  a session from another project.
- `/session compact` and `/compact` summarize the prior conversation into a
  short brief to free context space; auto-compact is on by default
  (`HK2_ENABLE_AUTOCOMPACT`, see
  [Environment variables](../reference/environment-variables.md)).
- `/remember <fact>` records an environment fact that stays in scope for the
  whole session and survives compaction; `/forget` removes it. See
  [Slash commands](../reference/slash-commands.md#remember).
- `/clear` clears the in-memory context only — the transcript on disk is
  preserved and can be resumed later.

## Related documentation

- [Slash commands](../reference/slash-commands.md) — full `/model`, `/project`, `/session` reference
- [Configuration](../reference/configuration.md) — `models.json` / `projects.json` schemas
- [REPL and TUI](repl-and-tui.md) — where these commands are used
