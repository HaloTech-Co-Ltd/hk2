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
- One install manages multiple providers and models.

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
| `--base-url=URL` | API endpoint base URL (provider-level); a URL already ending in `/chat/completions` (openai) or `/messages` (anthropic) is used as the full endpoint as-is |
| `--api-key=KEY` | API key (provider-level) |
| `--name=NAME` | Wire model code sent to the API |
| `--reasoning=on\|off` | Enable/disable reasoning |
| `--context-window=N` | Context window size (tokens) |
| `--max-tokens=N` | Max output tokens |
| `--temperature=N` | Sampling temperature |
| `--model-type=TYPE` | Model family (`/model types` lists all values) |
| `--model-options=JSON` | Model-specific options, e.g. `'{"enable_thinking":true}'` |
| `--multimodal=on\|off` | Multimodal input (default `off`); `on` enables image / video / audio attachments — see [multimodal input](#multimodal-input) |

`--model-type` declares the model family so hk2 can apply family-specific
behavior. Types with declared features validate `--model-options` — e.g.
`--model-type=glm-5.3` (and `glm-5.3-flash`) accepts
`{"reasoning_effort":"max"}` with max (deep reasoning) the default and
recommended, or high (enhanced) / low (light). Omitting the flag (or an old
record missing the field) defaults to `generic`; passing an **unknown** type
is rejected by the command.

## Multimodal input

A model configured with `--multimodal=on` accepts image / video / audio
input alongside text. The flag defaults to `off` and is only accepted for
multimodal-capable model types — currently `glm-5.3-flash` (see
[BigModel's glm-5.3-flash docs](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)).
Setting `--multimodal=on` on any other model type is **rejected with an
error**;
`/model types` lists the capable types.

```text
/model add bigmodel glm-5.3-flash --model-type=glm-5.3-flash --multimodal=on
/model set bigmodel/glm-5.3-flash --multimodal=on    (existing model)
```

With a multimodal model active, the common path is to **do nothing special**:
just ask the agent to analyze a media file. When the agent `read`s an image /
video / audio file, hk2 automatically injects the real content (Base64 data
URL content blocks) into the conversation, so the next model round actually
"sees" the pixels/audio — no manual step needed (see
[agent tools — read](../reference/agent-tools.md#read)):

```text
What problem does ./screenshots/error.png report?
```

You can also stage attachments manually with `/attach` and send them with
your next message (both paths are equivalent and share the 20 MB per-file
cap):

```text
/attach ./screenshots/error.png ./demo/trace.mp3
这张图片里报告了什么问题？
```

- Supported media: images (png / jpg / jpeg / gif / webp / bmp), video
  (mp4 / mov / mkv / avi / webm / flv / m4v), audio
  (wav / mp3 / m4a / aac / ogg / flac / opus).
- Local files are read and **Base64-encoded as data URLs** at send time
  (20 MB per-file limit); remote image / video http(s) URLs pass through
  untouched.
- Attachments ride exactly **one** user message, then clear automatically;
`/attach` lists what is staged and `/attach clear` drops it. Media injected
via `read` behaves the same — it rides only the injected message, and
re-reading the same file injects it once.
- On the wire, hk2 sends multimodal turns as `messages[].content[]`
content blocks (`image_url` / `video_url` / `input_audio` on OpenAI-style
endpoints; converted to the Anthropic image block on anthropic-style
endpoints, where video / audio degrade to text placeholders).

As an alternative to manual entry, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
in the environment seeds a matching provider **once, when the model registry
file is first created** — later starts do not re-scan or append.

## Phase models

Four pipeline phases can use a different model than the session model, per
project:

| Phase | Runs |
|---|---|
| `rewrite-query` | Query rewrite before BM25 retrieval |
| `request-assess` | Request-clarity assessment |
| `plan-review` | Automatic review of a confirmed plan (`HK2_ENABLE_PLANREVIEW=1`) |
| `code-review` | Automatic end-of-turn review of the completed task (`HK2_ENABLE_CODEREVIEW=1`); the manual `/review code` command resolves its model separately |

```text
/model set-phase --phase=rewrite-query local/mymodel
/model set-phase --phase=code-review --clear
```

When unset, a phase uses the session model. Phase-model selection differs
between the automatic pipeline phases and the manual `/review code` command:

- **Automatic phases** (`rewrite-query`, `request-assess`, and the automatic
  `plan-review` / `code-review` runs) — three distinct outcomes:
  - **Stale/unresolvable registry ref** (unknown provider or model —
    `resolveModelRef` returns null): treated **silently** as no override for
    this resolution attempt. The phase uses the session model, with no
    warning and no fallback/skip audit event. The stored ref remains in
    configuration and can resolve again if the provider/model is restored.
  - **Resolution throws** (for example, a registry read or resolution
    exception): the caller warns and uses the session model. This is
    different from a stale ref returning `null`.
  - **Successfully resolved, then the call fails** (transport/HTTP/timeout):
    `rewrite-query` / `request-assess` follow
    `HK2_ENABLE_PHASEMODEL_FALLBACK` (warn + re-run on the session model by
    default; `0` = warn + skip), while the automatic reviews warn and skip
    rather than silently substitute a different reviewer. These are the
    fallback/skip outcomes recorded for auditing.
- **Manual `/review code`** — an explicitly invalid or nonexistent
  `--model` aborts the command with no fallback; with no explicit `--model`,
  a stale project `code-review` phase ref — or a phase-ref resolution
  exception — warns and uses the session model; once a reviewer is
  selected, an actual call failure warns and skips the review rather than
  switching to another model.

See the model-resolution comparison table in
[Planning and review](planning-and-review.md#review-models); the
silent-stale-ref behavior of the automatic phases is a known limitation.

## Claude Code first-run import

When no default model is configured and no `claude` provider exists, `hk2 --tui`
automatically imports one from Claude Code's `~/.claude/settings.json` — the `env` block's
`ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, with
`ANTHROPIC_DEFAULT_*_MODEL` and `ANTHROPIC_MODEL` as model hints (duplicates are
removed; if none is set, the importer seeds `claude-sonnet-4-6`). A notice line
under the welcome card reports the import.

- **Fill-only** — an existing default or `claude` provider is never overwritten.
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

Projects are registered in `~/.hk2/projects.json` with a generated UUID. The
`current` field is the shared registry's default pointer: `/project list` marks
it with `*`, and `/project set current` changes it. `hk2 --project=<name>` and
`--project-id=<id>` pin only the current session, so a pinned session may differ
from the shared pointer and multiple processes may use different pins.

```text
/project init --name=myapp --source=/path/to/repo --source-root=src
/project list
/project set current <id|name>
/project set name new-name
/project set source /new/path
/project set source-root src
/project set include <full-glob-list-with-your-addition>
/project set exclude <full-glob-list-with-your-addition>   # both REPLACE the defaults
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
  The old directory remains as an orphan under
`$HK2_KB_DIR/<old-uuid>/` (default `$HK2_HOME/kb/<old-uuid>/`)
  (delete it manually if you want). Reusing an old KB currently requires
  restoring the original project record with its UUID; there is no CLI
  command for that yet.

The same registration is available from the shell:
`hk2 --mode=project-init --name=myapp --source=/path/to/repo`.

### Shared current pointer versus session pin

`projects.json.current` is the shared registry's default project pointer; `/project list`
marks it with `*`, and `/project set current` changes it and switches the current
interactive session. `hk2 --project=<name>` and `--project-id=<id>` pin only the
current session, without changing the shared pointer. A session pin can therefore
differ from `current`, and multiple processes can use different pins concurrently.

## Sessions

Sessions are stored as JSONL transcripts at
`~/.hk2/sessions/<projectId>/<sessionId>.jsonl`.

New transcripts persist each complete assistant message before the tool
results from that same loop round. Resuming therefore reconstructs the
original assistant/tool ordering, including assistant text emitted before a
tool call. Failed retry attempts and interrupted partial streams are not
stored as complete assistant messages. The final non-tool assistant round is
the answer used by `session.lastAnswer` and Code Review; earlier tool-round
text remains conversation history rather than being concatenated into it.
Older flat transcripts are still replayed best-effort, but they cannot always
recover the original boundary between consecutive tool rounds.

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
- `/remember <fact>` keeps an environment fact in scope for the whole session
  after successful persistence and survives compaction; `/forget` removes it. See
  [Slash commands](../reference/slash-commands.md#remember).
- `/clear` clears the in-memory context only — the transcript on disk is
  preserved and can be resumed later.
- `/session new` preserves the current project and model selection, starts a
  new transcript, and clears conversation/task/plan/review snapshots, session
  facts, counters, cooldowns, and other current-session state. It flushes the
  old transcript but does not blindly delete project-level `taskstate.json`.
- `/session resume` first reads and rebuilds messages from the target transcript.
  Only then does it clear old task/review/plan state and restore the task anchor when saved
  `userRequest` exists and `sessionId` matches that transcript. The plan panel
  is restored only if the saved plan has unfinished steps. `lastCompletedTask` is process-memory
  only: every resume and `/session new` clears it; switching to a different
  project clears it too, while setting the shared pointer to the project this
  session already uses is a deliberate no-op. Resumed `/review code` derives
  the original requirement by deterministic transcript scanning.

## Related documentation

- [Slash commands](../reference/slash-commands.md) — full `/model`, `/project`, `/session` reference
- [Configuration](../reference/configuration.md) — `models.json` / `projects.json` schemas
- [REPL and TUI](repl-and-tui.md) — where these commands are used
