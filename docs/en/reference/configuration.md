# Configuration

English | [简体中文](../../zh-CN/reference/configuration.md)

Reference for hk2's on-disk configuration: the `HK2_HOME` directory, the
model registry, the project registry, per-project settings, the KB layout,
session transcripts, and logs. The parsing logic lives in
`lib/config/home.js`; when editing this page, re-check it and
`src/slash/model.js` / `src/slash/project.js`.

## `HK2_HOME` layout

`HK2_HOME` defaults to `~/.hk2` and can be overridden with the `HK2_HOME`
environment variable. On creation hk2 chmods the directory to 0700 and the
key-bearing files (`models.json`, `projects.json`) to 0600 (best-effort —
chmod failures are ignored; POSIX permission semantics may not apply on
other platforms).

```text
~/.hk2/
├── models.json                       # Multi-provider model registry
├── projects.json                     # Project registry + current pointer
├── setting.json                      # Global filesystem-permission baseline (optional)
├── settings/
│   └── <project-id>/setting.json     # Managed per-project permission overrides
├── theme.json                        # Tool-card color customizations (/theme)
├── history.jsonl                     # REPL input history (capped at 1000 entries)
├── kb/                               # default KB root; overridden by HK2_KB_DIR
│   └── <projectId>/                  # Per-project KB (see below)
├── sessions/
│   └── <projectId>/
│       ├── taskstate.json            # Interrupted-task state (--resume restores it)
│       ├── <sessionId>.jsonl         # Session transcripts (JSONL)
│       └── <sessionId>.facts.json    # Session facts store (/remember)
└── logs/
```

> `~/.hk2` also doubles as the default **install dir** for the source copy
> when installed via `install.sh`. See
> [Installation](../getting-started/installation.md) for reinstall
> data-preservation behavior.

## `models.json`

```json
{
  "providers": {
    "local": {
      "api": "openai",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "sk-example",
      "models": [
        {
          "id": "mymodel",
          "name": "mymodel",
          "contextWindow": 131072,
          "maxTokens": 32768,
          "temperature": 0.2,
          "reasoning": true,
          "modelType": "generic",
          "modelOptions": {}
        }
      ]
    },
    "anthropic": {
      "api": "anthropic",
      "apiKey": "sk-example",
      "models": [
        { "id": "claude-opus-4-8", "name": "claude-opus-4-8", "contextWindow": 200000, "maxTokens": 32000, "reasoning": true }
      ]
    }
  },
  "default": "local/mymodel"
}
```

Field notes:

- `api` — provider-level dialect: `openai` or `anthropic`.
- `id` — the ref key in `provider/id`; may carry a trailing context-window
  hint like `[1m]`.
- `name` — the wire model code sent in the API request body; set it to the
  exact string the provider expects. Keeping the hint on `id` and the clean
  code on `name` avoids "model code not found" gateway errors.
- `modelType` — family declaration validated by `/model add|set
  --model-type`; defaults to `generic`. `/model types` lists all values.
- `modelOptions` — model-specific options object (e.g.
  `{"reasoning_effort":"max"}` for the glm-5.3 family), validated against
  the type's declared features. Written by `/model add|set
  --model-options`; the runtime reads the `modelOptions` key, so hand-edited
  entries must use exactly that name.
- Provider-level optional fields: `headers` (extra HTTP headers resolved
  into the LLM config for every call) and importer metadata
  `importedFrom` / `importedAt` (written by the Claude Code first-run
  import). `mcpServers` below is a **model-level** field, not a provider
  one.
- `mcpServers` — optional array of MCP server attachments added via
  `/model add-mcpserver` (type, name, options with the `$APIKEY`
  placeholder).
- `timeout` is **not a persisted field** — `/model add|set` have no
  `--timeout` flag. The runtime always resolves the effective timeout from
  `HK2_LLMAPI_TIMEOUT_MS` when a model config is resolved.

Prefer editing models through `/model` commands rather than by hand — they
validate types, options, and refs.

## `projects.json`

```json
{
  "current": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
  "projects": {
    "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d": {
      "id": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
      "name": "myapp",
      "sourcePath": "/path/to/repo",
      "sourceRoot": "src",
      "includeGlobs": ["**/*.js", "**/*.ts", "**/*.py"],
      "excludeGlobs": ["**/node_modules/**"],
      "extraRoots": [{ "name": "docs", "relRoot": "docs" }],
      "defaultModel": "local/mymodel",
      "phaseModels": { "rewriteQuery": "local/mymodel" },
      "kbBuiltAt": "2026-07-24T16:41:44.248Z",
      "createdAt": "2026-07-24T16:41:43.000Z",
      "updatedAt": "2026-07-24T16:41:44.000Z"
    }
  }
}
```

Field notes:

- `current` — the shared registry's default project pointer (a UUID), marked
  with `*` by `/project list` and changed by `/project set current`. A session
  started with `hk2 --project=<name>` or `--project-id=<id>` pins its project
  for that session without rewriting this pointer; multiple processes can use
  different session pins at once.
- `sourcePath` — where the project lives; `sourceRoot` — the indexed
  sub-directory (whole tree when empty).
- `includeGlobs` / `excludeGlobs` — the glob sets used by `/kb init`;
  defaults cover common source and document extensions.
- `extraRoots` — named extra roots registered with
  `/project init --extra=<name>:<rel>,...`; walked in addition to the main root.
  The direct `--mode=project-init` CLI does not parse this option. Each
  element has the shape `{ "name": "...", "relRoot": "..." }`.
- `defaultModel` — per-project default model override written by
  `/model set-default current <ref>`; `--clear` removes it.
- `updatedAt` — last-modified timestamp maintained on project writes.
- `phaseModels` — per-project phase model overrides written by
  `/model set-phase` (storage keys `rewriteQuery`, `requestAssess`,
  `planReview`, `codeReview`).

## Default include / exclude globs

When a project does not override them, `/kb init` walks with these defaults
(`lib/config/home.js`). A project's `includeGlobs`/`excludeGlobs` — set via
`/project init --include/--exclude` or `/project set include/exclude` —
**replace these lists entirely**; they are not merged.

- **Include** — C/C++ (`.c .h .cpp .cc .hpp .cxx`), JS/TS
  (`.js .jsx .mjs .cjs .ts .tsx`), Python, Go, Rust, Java, Kotlin, Scala,
  Ruby, PHP, Swift, shell (`.sh .bash .zsh`), lex/yacc (`.y .l`), and
  documents (`.md .markdown .txt .rst .adoc`, `README*` `LICENSE*`
  `CHANGELOG*` `CONTRIBUTING*`, `.json .yaml .yml .html .htm .sgml .pdf
  .doc .docx .ppt .pptx`).
- **Exclude** — generated parser files (`gram.c`, `scan.c`, `kwlist.c`),
  vendored/build artifacts (`node_modules`, `dist`, `build`, `target`,
  `.venv`, `vendor`, `__pycache__`), VCS dirs (`.git`, `.svn`, `.hg`), and
  editor state (`.idea`, `.vscode`, `.DS_Store`).

## KB layout

```text
$HK2_KB_DIR/<projectId>/  # default: $HK2_HOME/kb/<projectId>/
├── meta.json                 # KB metadata
├── holy/                     # Holy Space — stable knowledge entries
│   └── <entry-id>.json
├── eden/                     # Eden Space — frequently-updated knowledge
│   └── <entry-id>.json
├── graph/                    # Knowledge graph (Index Space)
│   ├── nodes.json            # id → node record
│   ├── edges.calls.json      # srcId → [calleeIds, ...]
│   ├── edges.imports.json
│   ├── edges.inherits.json
│   ├── edges.contains.json
│   ├── by_kind.json          # kind → [nodeIds, ...]
│   ├── by_qual.json          # qualName → nodeId
│   └── meta.json             # counts + version
├── files.json                # Index Space — file registry
├── inverted.json             # Index Space — BM25 inverted index
├── holy.idx.json             # BM25 index over Holy knowledge entries
├── eden.idx.json             # BM25 index over Eden knowledge entries
├── doc_index.json            # Parsed-document index (doc reference graph)
├── callgraph.json            # Index Space — legacy callgraph (derived from graph)
├── symbols.0000.json         # Index Space — sharded symbol table
├── stats.json                # Index Space — build statistics
├── checkpoint.json           # Resumable build state (transient — cleared on success)
├── summaries/                # Per-symbol summaries (on-demand)
└── backup/                   # Pre-upgrade knowledge snapshots
```

Parser-owned document entries use the `doc:<relpath>` Eden namespace. Their
on-disk filenames are sanitized, but the `doc:` id is retained; `/kb init` and
`/kb update` may replace or remove these entries as documents change, are
deleted, or are excluded. Use another id for hand-authored document knowledge.

## Sessions and logs

- **Interrupted-task state** —
  `~/.hk2/sessions/<projectId>/taskstate.json` persists the interrupted
  task (original request, summary, plan progress) that `--resume` restores.
  A fresh launch can also load the task anchor and hold an unfinished plan
  pending until the first agent turn chooses continuation or a new task; see
  [Interruption and recovery](../concepts/agent-workflow.md#interruption-and-recovery).
- **Continuation classification state** — the `lastCompletedTask` original-request
  snapshot exists only in the current process; it is not written to disk. It is
  cleared by `/session new`, by any resume, and when switching to a different
  project; `/project set current` is a no-op when it names the project already
  bound to this session. A resumed session falls back to a deterministic
  transcript scan. Tier-2 continuation upgrade is controlled by
  `HK2_ENABLE_CONTINUATION_UPGRADE` and
  `HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE`.
- **Transcripts** — `~/.hk2/sessions/<projectId>/<sessionId>.jsonl`. Each
  successfully completed tool round records its complete assistant message
  before the associated tool results, preserving call/result order; the final
  non-tool answer is a separate message. The turn also records metadata (`assess`, `rewrite`, `graph`, `codeReview`,
  `learned_knowledge`, usage stats). On interruption, streamed partial assistant
  text remains on screen but is not recorded as a complete assistant turn;
  dangling tool calls are cleaned and interrupted-task state is stored separately
  in `taskstate.json`. `--resume` replays the transcript and task state.
  `session.lastAnswer` and Code Review input use only the final non-tool answer,
  while legacy flat records can only be replayed with their original fidelity.
- **Session facts** — `~/.hk2/sessions/<projectId>/<sessionId>.facts.json`
  holds the compaction-immune facts recorded via `/remember` / the
  `remember` tool (max 100 per session). `/remember --project` additionally
  appends to the project-level Eden entry `env-facts`, which lives in the
  normal KB layout and is searchable across sessions.
- **Logs** — `~/.hk2/logs/`.

## Concurrent registry writes

The normal model/project mutation helpers use per-registry advisory lockfiles
(`models.json.lock` and `projects.json.lock`) around a fresh read-modify-write.
They serialize callers in the same process and coordinate cooperating hk2
processes. Lock metadata includes the PID, process-start identity where Linux
`/proc` provides it, and a random ownership token. Release removes a lock only
when that token still matches; dead owners, reused PIDs, and abandoned stale
recovery gates can be reclaimed.

This is scoped protection for mutations that use `withModels()` or
`withProjects()`; it is not a transaction across both registries, KB files, or
manual edits. The lock is advisory, and filesystems that cannot provide the
required exclusive-create/link semantics degrade to an unlocked
last-writer-wins update. Acquisition otherwise retries for up to 10 seconds by
default and then fails. Atomic JSON replacement prevents torn target files but
does not broaden the lock into a multi-file transaction.

Claude Code first-run import performs an unlocked early no-op check for speed,
then re-reads and rechecks both the current default and the `claude` provider
inside the `models.json` lock before writing. A concurrent user configuration
therefore wins over the importer.

## Permission config

`setting.json` (global) and `settings/<project-id>/setting.json` (project)
hold the filesystem permission rules. The full semantics — longest-prefix
resolution, deny/allow priority, symlink handling, the agent read-only
guarantee — are documented once in
[Security and permissions](../guides/security-and-permissions.md); see
`setting.example.json` for a commented example.

## Related documentation

- [Models, projects, and sessions](../guides/models-projects-and-sessions.md) — managing these registries day to day
- [Environment variables](environment-variables.md) — `HK2_HOME`, `HK2_KB_DIR`, and friends
- [Security and permissions](../guides/security-and-permissions.md) — permission rule semantics
