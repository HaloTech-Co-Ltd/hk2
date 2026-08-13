# hk2

A knowledge-base (KB) driven coding agent. Combines an interactive REPL with tool use and a per-project KB as the central source of truth.

English | [简体中文](README_zh.md)

## Key ideas

- **Tree-sitter AST parsing**: hk2 uses native tree-sitter grammars for precise symbol extraction across 14 packages (15 grammars, since `tree-sitter-typescript` exports both `typescript` and `tsx`). Falls back to regex-based parsers if grammars are not installed.
- **Code knowledge graph**: call chains, class hierarchy, imports, and inheritance are stored as a graph under `~/.hk2/kb/<projectId>/graph/`. Traversable via `kb_callchain`, `kb_class`, `kb_refs`, `kb_implements`.
- **Three-space KB**: every project KB is split into Holy Space (stable design knowledge), Eden Space (frequently-updated catalogs/patterns), and Index Space (BM25 + graph + per-space indexes).
- **Document parsing**: Markdown, JSON, YAML, HTML, SGML, plain text are parsed with stdlib. PDF and Word (.docx) supported via optional `pdf-parse` and `mammoth`. Legacy Office binaries (.doc, .pptx, .ppt) are extracted dependency-free. Docs are routed into Eden Space as `doc:<relpath>` entries.
- **Per-request knowledge graph**: for each user message, hk2 retrieves related symbols, call chains, class membership, knowledge entries, and docs from the KB, then injects them as context before the LLM responds.
- **KB-first policy**: the agent always tries KB tools (`kb_search`, `kb_symbol`, `kb_callchain`, `kb_class`, `kb_refs`, `kb_implements`, `kb_knowledge`, etc.) before falling back to `bash grep`/`find`. Mid-turn guardrails detect violations and nudge the agent back to the KB.
- **Resumable builds**: `/kb init` saves a checkpoint every 100 files (configurable). If interrupted, re-running resumes from the checkpoint — no re-parsing.
- **Auto-generated summaries**: at end of `/kb init`, an LLM authors three Eden entries: `project-overview`, `architecture-diagram`, `architecture-decisions`. Always available via `kb_knowledge`.
- **Multi-project, multi-model**: one `~/.hk2/` install manages unlimited projects (UUID-isolated KBs) and unlimited LLM providers/models.
- **Any language**: C/C++, C#, JavaScript/TypeScript, Python, Go, Rust, Java, Kotlin, Scala, Ruby, PHP, Swift, Bash/Zsh, lex/yacc.

## Requirements

- Node.js >= 18 (Node 20 LTS recommended for Tree-sitter native compatibility)
- `npm install` for Tree-sitter native bindings (14 language packages)

> **Tree-sitter compatibility note**: very new Node versions (e.g. Node 25+)
> may have N-API / V8 ABI mismatches with the prebuilt Tree-sitter binaries
> on some platforms. If `/kb init` logs `tree-sitter parse failed`, hk2
> transparently falls back to its regex-based parsers — symbol coverage is
> somewhat lower but the system is fully functional. For maximum precision
> install on Node 20 LTS or run `npm rebuild` to recompile from source.

## Install

hk2 is not published to npm. Install from source:

### Option A — install.sh (recommended)

Creates a self-contained copy of the source tree at `~/.hk2`, symlinks `hk2` into your PATH,
and runs `npm install` to build Tree-sitter native bindings.

> `~/.hk2` serves two roles: it is the **config / data home** (`HK2_HOME` -
> `models.json`, `projects.json`, `kb/`, `sessions/`, `logs/`) *and* the default
> **install dir** for the source copy. Because of this overlap, prefer `npm link`
> if you already have a checkout, or set `HK2_INSTALL_DIR` to a separate path.

```bash
git clone <repo-url> hk2 && cd hk2
./install.sh
```

Custom prefix or install location (prefix also settable via the `HK2_PREFIX` env var):

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # same as default
HK2_INSTALL_DIR=~/.hk2-src ./install.sh   # keep the source copy out of the config home
./install.sh --no-npm-install             # skip Tree-sitter (regex fallback)
```

Optional PDF / Word parsing:

```bash
cd ~/.hk2 && npm install                  # installs pdf-parse + mammoth
```

Uninstall: remove the symlink and the source copy. Because `~/.hk2` also holds
your config and KBs, deleting the whole directory wipes those too - back up
`models.json` / `projects.json` / `kb/` first, or just remove the symlink:

```bash
rm -f /usr/local/bin/hk2                  # drop the launcher
rm -rf ~/.hk2/node_modules ~/.hk2/bin      # remove the installed source copy, keep config + KBs
```

### Option B — npm link (for developers)

Creates a live symlink to the working tree. Useful if you are hacking on hk2 itself and want changes to take effect immediately.

```bash
git clone <repo-url> hk2 && cd hk2
npm link
```

Uninstall: `npm unlink -g hk2`

### Verify

```bash
hk2 --help
```

## Quick start

```bash
# Enter the interactive REPL
hk2
```

Inside the REPL:

```
# 1. Register a project
/project init --name=myapp --source=/path/to/repo --source-root=src

# 2. Build the code index (Index Space)
/kb init

# 3. Deep-study the whole project → auto-generate Eden knowledge entries
/kb knowledge init

# 4. Ask a question (the agent retrieves KB context + uses tools automatically)
How does login verify the password?

# 5. Explicit KB queries
/kb search password verification
/kb symbol login
/kb neighbors 12:345
/kb knowledge list
/kb knowledge show spi-extension-pattern

# 6. Switch projects / models
/model list
/model set-default local/gpt-4o
/model use local/gpt-4o          # session only
/project list
/quit
```

## Three-space KB model

| Space | Contents | Update policy |
|---|---|---|
| **Holy** | Stable design knowledge (architecture, algorithms, key patterns). Manually authored or imported from authoritative sources. | **Always requires explicit user approval**, even when `HK2_ENABLE_AUTOUPDATEKB=1` or `HK2_ENABLE_AUTO_LEARN=1`. |
| **Eden** | Frequently-updated knowledge (function catalogs, command lists, observed patterns, module summaries, **parsed docs**, **auto-generated summaries**). | Auto-updatable when `HK2_ENABLE_AUTO_LEARN=1`; otherwise prompts y/N. |
| **Index** | Code index (BM25 over symbols), knowledge graph (call chains / class hierarchy / imports / inheritance), and per-space indexes over Holy/Eden entries. | Auto-updatable when `HK2_ENABLE_AUTOUPDATEKB=1`; otherwise prompts y/N. |

### Knowledge graph

On `/kb init`, hk2 builds a code knowledge graph from the AST:

```
~/.hk2/kb/<projectId>/graph/
  nodes.json            id → node record (function / method / class / interface / struct / field)
  edges.calls.json      srcId → [calleeIds, ...]
  edges.imports.json    srcId → [importedFileNodeIds, ...]
  edges.inherits.json   srcId → [baseClassIds, ...]
  edges.contains.json   srcId → [memberIds, ...]
  by_kind.json          kind → [nodeIds, ...]
  by_qual.json          qualName → nodeId
  meta.json             counts + version
```

The graph is queried via:

- **kb_callchain** — bounded DFS over the call graph (forward, backward, both)
- **kb_class** — class / interface / struct lookup with members + implementations
- **kb_refs** — who calls / imports / derives from a symbol
- **kb_implements** — find every class that implements an interface

### Auto-generated Eden entries

`/kb init` and `/kb knowledge init` produce complementary sets of LLM-authored Eden entries. None require manual writing — both commands overwrite prior versions on each run.

**`/kb init`** writes 3 high-level structural entries (skipped with `--skip-summary`):

| Entry id | Contents |
|---|---|
| `project-overview` | 600–900-word prose summary: what the project does, high-level architecture, key modules, notable patterns. |
| `architecture-diagram` | A Mermaid flowchart of module / layer relationships with a short legend. |
| `architecture-decisions` | 4–8 ADR-style entries inferred from detected technologies, each with concrete modification suggestions. |

**`/kb knowledge init`** writes 3 project-wide survey entries as Phase 0, then N topic-specific entries as Phase 2:

| Entry id | Phase | Contents |
|---|---|---|
| `api-docs` | 0 | Numbered reference for the most important public / exported symbols across the whole project. |
| `code-walkthrough` | 0 | 4–8 sections walking through the most central core abstractions. |
| `usage-examples` | 0 | 3–5 numbered quickstart examples using real public symbols. |
| `<topic-id>` (dynamic) | 2 | One entry per LLM-planned topic (5–30 entries), each focused on a coherent subsystem (e.g. `buffer-pool`, `transaction-mgmt`, `wal-replay`). |

Retrieve any of them via `kb_knowledge("<id>")` or `kb_search_knowledge("overview")`.

### Knowledge commands

| Command | Description |
|---|---|
| `/kb knowledge list [--space=holy\|eden]` | List knowledge entries |
| `/kb knowledge show <id>` | Show full entry (searches both spaces) |
| `/kb knowledge add [--space=holy\|eden] [--id=...] --title="..." [--intro="..." \| --intro-file=PATH] [--key-files=...] [--key-symbols=...] [--keywords=...]` | Manually add an entry |
| `/kb knowledge init [--per-batch-chars=N] [--dry-run] [--base-dir=PATH]` | Two-phase deep-study: LLM plans study batches from the full project map, then executes each batch to auto-generate Eden entries. Cross-checks against Holy; conflicts follow Holy. `--base-dir=PATH` restricts the study to files under one subdirectory and skips the three project-wide survey entries. |
| `/kb knowledge export <eden\|holy\|all> <path>` | Export entries to a JSON file (version 2 format with per-entry `space` tags) |
| `/kb knowledge import <path> [eden\|holy\|adaptive] [--overwrite]` | Import entries from JSON. `adaptive` routes each entry to its original space. Holy imports always prompt y/N. |
| `/kb knowledge housekeep <eden\|holy\|all>` | Remove entries with missing fields, duplicate ids, or near-duplicate titles/keywords. Holy always prompts. |
| `/kb knowledge empty <eden\|holy\|all>` | Remove ALL entries from the specified space(s). Irreversible, always prompts y/N. |
| `/kb knowledge del <id>` | Delete an entry (requires confirmation) |
| `/kb transform <id> <from> <to>` | Move an entry between Holy and Eden (requires confirmation) |

## REPL command reference

Type `/help` for the full list. Common commands:

| Command | Description |
|---|---|
| `/model list` | List all providers / models |
| `/model add <prov> <id> [--api=...] [--base-url=...] [--api-key=...] [--reasoning] [--context-window=N]` | Add a model |
| `/model set <prov>/<id> [--name=...] [--reasoning=on\|off] [--context-window=N] [--max-tokens=N] [--temperature=N] [--api=...] [--base-url=...] [--api-key=...]` | Modify a model's persisted settings |
| `/model set-default <prov>/<id>` | Set global default (persisted) |
| `/model use <prov>/<id>` | Choose model for current session only |
| `/model del <prov>/<id>` | Delete |
| `/model show` | Show current default details |
| `/project init --name=... --source=... [--source-root=...]` | Register a new project |
| `/project list` | List all projects |
| `/project set current <id\|name>` | Switch current project |
| `/project set name <new-name>` | Rename |
| `/project show` | Current project details |
| `/project drop <id\|name>` | Remove a project (KB preserved) |
| `/kb init [--full] [--checkpoint-interval=N] [--no-resume] [--no-checkpoint] [--skip-summary]` | Build KB for current project (resumable, auto-generated summaries) |
| `/kb update` | Incremental update (Index Space) |
| `/kb status` | KB statistics (per-space counts) |
| `/kb search <query> [--top-k=N]` | BM25 + reranking symbol search |
| `/kb symbol <name>` | Look up symbol by exact name |
| `/kb neighbors <symbol_id>` | Call-graph neighbors |
| `/kb knowledge list` | List Holy + Eden entries |
| `/kb knowledge show <id>` | Show full entry |
| `/kb knowledge add [...]` | Manually add an entry |
| `/kb knowledge init [--dry-run] [--base-dir=PATH]` | Deep-study project (or one subdirectory via `--base-dir`) → auto-generate Eden |
| `/kb knowledge export <scope> <path>` | Export entries to JSON |
| `/kb knowledge import <path> [adaptive]` | Import entries (adaptive routes by original space) |
| `/kb knowledge housekeep <scope>` | Remove duplicates and invalid entries |
| `/kb knowledge empty <scope>` | Remove ALL entries from space(s) |
| `/kb knowledge del <id>` | Delete entry |
| `/kb transform <id> <from> <to>` | Move between Holy and Eden |
| `/kb drop` | Delete KB (confirm required) |
| `/session info` | Current session id, project, message count |
| `/session list` | Recent sessions |
| `/session new` | Start a new session |
| `/session resume <id>` | Resume a previous session |
| `/clear` | Clear conversation context |
| `/compact` | Summarize earlier messages |
| `/help` `/quit` `/exit` | Help / exit |

## Agent tools

The agent can call these tools mid-turn (OpenAI/Anthropic native tool-calling):

| Tool | Description |
|---|---|
| `read` | Read file contents (line-numbered, offset/limit). Code files known to the KB get an `## Outline (from KB)` section prepended and a `tag` field returned for stale-anchor protection. |
| `write` | Create or overwrite a file |
| `edit` | Precise string replacement (supports multiple disjoint edits). Optional `tag` rejects stale-anchor edits. |
| `bash` | Execute shell commands (sandboxed to workspace) |
| `find` | Glob-pattern file search |
| `grep` | Regex content search |
| `ast_grep` | Structural code search with `$$$IDENT` / `$IDENT` / `$_` metavariables (ast-grep style). When the pattern is a single exact identifier the KB knows, prepends a kb-first hint toward `kb_symbol`. |
| `ast_edit` | Structural rewrite across files. Returns a unified-diff preview + `proposalId`; never writes itself. Optional `tag` validates target files at preview time. |
| `resolve` | Apply or discard a previously-previewed `ast_edit` proposal. Re-validates tags at apply time, rolls back on any failure. |
| `plan` | The triage assistant's interface for surfacing a user-confirmed execution plan. The LLM calls it when it decides a task is complex enough to warrant a strategy decision (multiple distinct phases, a design choice the user should confirm, or several affected subsystems); simple tasks skip straight to execution. It returns a one-line summary plus 2–5 ordered steps, each with 2–4 candidate strategies (one marked recommended), and surfaces the plan for per-step strategy selection. |
| `plan_step` | Mark a step of a currently confirmed plan as done and advance the live progress panel. Call it exactly once after finishing each confirmed plan step (the one returned by `plan`); `step` is 1-based (omit to advance the current step). Pure progress-UX signal - no-op when no plan is active, and the panel clears automatically after the last step. Do not call it before `plan` returns a confirmed plan. |
| `kb_search` | BM25 symbol search (with LLM query rewrite by default) |
| `kb_symbol` | Look up symbol by exact name |
| `kb_outline` | File outline from the KB index — name / kind / lines / signature per symbol. Cheaper than `read` for "what's in this file?" questions. Returns a `tag` for downstream edit safety. |
| `kb_neighbors` | Call-graph 1-hop neighbors (legacy) |
| `kb_callchain` | Bounded DFS over the call graph (forward / backward / both) |
| `kb_class` | Class / interface / struct lookup with members, super-classes, implementations |
| `kb_refs` | Find callers, importers, derived classes for a symbol |
| `kb_implements` | Find every class that implements an interface or extends a base class |
| `kb_knowledge` | Look up a knowledge entry by id (Holy + Eden) |
| `kb_search_knowledge` | Search knowledge entries by natural-language query |
| `kb_save_knowledge` | Save a new knowledge entry to Holy or Eden |

### Kb-first policy

Every code-discovery path favours the KB index over fresh parsing:

- `kb_outline`, `kb_symbol`, `kb_search`, and the graph tools read directly from the index — no filesystem hit, no reparse.
- `read` on a code file prepends the KB-sourced outline so the agent sees structure before content.
- `bash grep/find/cat` and direct `read` calls without a prior KB tool get a one-time `[kb-first policy hint]` prepend; after the agent uses any KB tool the hint stops, signalling that subsequent bash/read fallbacks are intentional.
- `ast_grep` with a single exact identifier emits the same hint toward `kb_symbol`.

### Pattern syntax (ast_grep / ast_edit)

| Token | Meaning |
|---|---|
| `$$$IDENT` | Multi-wildcard capture — matches any text (multi-line, non-greedy). `IDENT` is captured into `meta.IDENT` for substitution. |
| `$IDENT` | Single identifier capture — matches `[A-Za-z_][A-Za-z0-9_]*`. |
| `$_` | Anonymous single-token wildcard (no capture). |
| other | Literal text, regex-escaped. |

Examples:

- `ast_grep("console.log($$$)")` — any console.log call
- `ast_grep("function $NAME($$$)", path="src")` — captures function names
- `ast_edit({ops:[{pat:"console.log($$$ARGS)", out:"logger.info($$$ARGS)"}], paths:["src"]})` — codemod every console.log → logger.info, args preserved (named captures round-trip; anonymous `$$$` does not)

### Hashline-style anchored edits

`read` and `kb_outline` results include a `tag` (the first 8 hex chars of the file's content hash). Echo it into subsequent `edit` or `ast_edit` calls and the tool rejects the change if the file was modified since the tag was minted:

```
read({path:"src/foo.js"}) → {tag:"a1b2c3d4", ...}
edit({path:"src/foo.js", old_string:..., new_string:..., tag:"a1b2c3d4"})
  → ok on match, error: "stale tag: file changed since read..." on mismatch
```

### Deferred capabilities

The following capabilities are intentionally **not** implemented yet, because they don't have a clean kb-first story and require multi-thousand-line integrations:

- **LSP integration** — would require spawning language servers, JSON-RPC capability negotiation, and diagnostics streaming. The KB symbol index already covers most "what does the IDE know?" queries; LSP would only add value for live diagnostics and rename refactors across unindexed files. Defer until that gap becomes blocking.
- **DAP debugging** — would require spawning debug adapters (gdb, lldb-dap, debugpy, dlv), breakpoint/step/variable protocols. Same scope as LSP. Defer until there's a concrete debugging workflow need.
- **Full hashline grammar** (`SWAP.BLK`, `INS.PRE/POST/HEAD/TAIL`, `MV`, `REM`) — v1 ships only the `tag` safety mechanism. The full line-anchored grammar is a future addition once the preview/accept flow is proven.
- **AST-aware ast_grep matching** — v1 uses a regex approximation (translates metavariables to capture groups). Full ast-grep pattern parity (true AST-boundary matching) is iterative.

## Status bar

A status bar is pinned to the bottom of the terminal (TTY mode only):

```
streaming │ postgres|kb|glm-5.2 │ ↑1.4k ↓120 0.1%/1.0M │ 4.2s
```

- `↑1.4k` — latest LLM call's input tokens
- `↓120` — latest LLM call's output tokens
- `0.1%` — current context usage (latest input / context window)
- `1.0M` — context window size

Updates live during streaming, tool calls, and phase transitions.

### Progress panel

When a task is complex enough, the agent calls `plan` to surface a user-confirmed
execution plan. A live progress panel is then pinned above the status bar showing
the plan's steps - which are done, which is in progress, and which are pending:

```
▣ Plan: sync README docs with code
  ✓ 1. Add missing plan_step tool
  ▶ 2. Document the progress panel
    3. Fix tree-sitter package count
    4. Commit and push
```

After finishing each confirmed step, the agent calls `plan_step` once to advance
the panel. Marking the last step done clears the panel automatically - no
separate finish call is needed. Simple tasks that skip `plan` never show a
panel. See the `plan` and `plan_step` entries in [Agent tools](#agent-tools).

When `HK2_ENABLE_PLANREVIEW=1` (default off), after the user confirms a plan,
an LLM reviews it and surfaces any issues one-by-one for confirmation before
execution begins; see the env-var table.

## Configuration layout

```
~/.hk2/
├── models.json                       # Multi-provider model registry
├── projects.json                     # Project registry + current pointer
├── kb/
│   └── <projectId>/                  # Per-project KB
│       ├── meta.json                 # KB metadata
│       ├── holy/                     # Holy Space — stable knowledge entries
│       │   └── <entry-id>.json
│       ├── eden/                     # Eden Space — frequently-updated knowledge
│       │   └── <entry-id>.json
│       ├── graph/                    # Knowledge graph (Index Space)
│       │   ├── nodes.json
│       │   ├── edges.calls.json
│       │   ├── edges.imports.json
│       │   ├── edges.inherits.json
│       │   ├── edges.contains.json
│       │   ├── by_kind.json
│       │   ├── by_qual.json
│       │   └── meta.json
│       ├── files.json                # Index Space — file registry
│       ├── inverted.json             # Index Space — BM25 inverted index
│       ├── callgraph.json            # Index Space — legacy callgraph (derived from graph)
│       ├── symbols.0000.json         # Index Space — sharded symbol table
│       ├── stats.json                # Index Space — build statistics
│       ├── checkpoint.json           # Resumable build state (transient)
│       └── summaries/                # Per-symbol summaries (on-demand)
├── sessions/
│   └── <projectId>/
│       └── <sessionId>.jsonl         # session transcript (JSONL)
└── logs/
```

### models.json schema

Each model has an `id` and a `name`. The `id` is the accounting key used in
`provider/id` refs (e.g. `local/glm-4.7`) and may carry a trailing bracketed
context-window hint such as `[1m]`. The `name` is the model code actually
**sent in the API request body** (the wire `model` field) — set it to the
exact string the provider expects (e.g. `glm-4.7`, never `GLM 4.7`). Keeping
the hint on `id` and the clean code on `name` avoids `[modelCode不存在]` on
gateways that reject `glm-4.7[1m]`.

```json
{
  "providers": {
    "local": {
      "api": "openai",
      "baseUrl": "http://10.16.6.162:18000",
      "apiKey": "sk-glm4-local",
      "models": [
        {
          "id": "glm-4.7",
          "name": "glm-4.7",
          "contextWindow": 131072,
          "maxTokens": 32768,
          "temperature": 0.2,
          "reasoning": true
        }
      ]
    },
    "anthropic": {
      "api": "anthropic",
      "apiKey": "...",
      "models": [
        { "id": "claude-opus-4-7", "name": "claude-opus-4-7", "contextWindow": 200000, "maxTokens": 32000, "reasoning": true }
      ]
    }
  },
  "default": "local/glm-4.7"
}
```

### projects.json schema

```json
{
  "current": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
  "projects": {
    "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d": {
      "id": "8ce5c38d-214c-4e0d-8ed1-30045dd3c99d",
      "name": "myapp",
      "sourcePath": "/path/to/repo",
      "sourceRoot": "src",
      "includeGlobs": ["**/*.js", "**/*.ts", "**/*.py", "..."],
      "excludeGlobs": ["**/node_modules/**", "..."],
      "extraRoots": [],
      "kbBuiltAt": "2026-07-24T16:41:44.248Z",
      "createdAt": "2026-07-24T16:41:43.000Z"
    }
  }
}
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `HK2_HOME` | Override `~/.hk2` location | `~/.hk2` |
| `HK2_KB_DIR` | Override KB root | `$HK2_HOME/kb` |
| `HK2_KB_NAME` | KB name for legacy `--mode` commands | Current project id, or `default` |
| `HK2_PROJECT_SOURCE` | Project source root for tool sandbox (set automatically in interactive mode) | - |
| `HK2_PREFIX` | Install prefix used by `install.sh` for the `hk2` symlink | `/usr/local` |
| `HK2_INSTALL_DIR` | Self-contained copy location used by `install.sh` (defaults to `HK2_HOME`, i.e. `~/.hk2`) | `~/.hk2` |
| `HK2_ENABLE_QUERYREWRITE` | When 1, hk2 uses an LLM call to rewrite each user query to English function names + keywords before BM25 retrieval (both at turn start and on each `kb_search` tool call). | `1` |
| `HK2_ENABLE_REQUEST_ASSESS` | When 1 (and `HK2_ENABLE_QUERYREWRITE=1`), hk2 first asks the LLM whether a user request is clear. If not, it surfaces the unclear aspects plus candidate interpretations as a numbered menu (with a free-text "something else" option) and feeds the chosen clarification back into the query rewrite. Active only in interactive TTY mode; one bounded round. Best-effort: any failure falls through to the normal rewrite. | `1` |
| `HK2_ENABLE_PLANREVIEW` | When 1, after the user confirms a plan, hk2 asks an LLM to review the finalized plan for problems (missing steps, wrong order, ambiguous goals, risky strategies). If the reviewer finds issues, each is surfaced to the user one-by-one for confirmation (accept the reviewer's suggestion / dismiss / type your own); the confirmed resolutions are appended to the plan returned to the agent. The review model is configurable via `/model set-phase --phase=plan-review <ref>` (same mechanism as `rewrite-query`); when unset it uses the session model. Active only in interactive TTY mode. Best-effort: any failure returns the already-confirmed plan unchanged. | `0` |
| `HK2_ENABLE_AUTOUPDATEKB` | When 1, hk2 silently runs an incremental `/kb update` (Index Space) at end of any turn where the agent fell back to bash to search source files. | `0` |
| `HK2_ENABLE_AUTO_LEARN` | When 1, hk2 silently asks the model to extract a reusable knowledge entry from the just-finished conversation and saves it to Eden Space. Holy Space ALWAYS prompts y/N regardless of this flag. | `0` |
| `HK2_KB_CHECKPOINT_INTERVAL` | Save `/kb init` checkpoint every N files | `100` |
| `HK2_INDEX_PARALLEL` | Parallelism of the KB index parse pool (`/kb init` / `/kb update`). `0` or unset = auto (host CPU count); a positive integer pins the width. | `0` |
| `HK2_DEBUG` | Print error stacks | - |
| `HK2_NO_COLOR` | When 1, disable ANSI colors (also honors the standard `NO_COLOR` env var). | - |
| `HK2_ASCII` | When 1, force ASCII fallbacks for box-drawing / spinner / icons instead of UTF-8 glyphs (useful on non-UTF-8 terminals). | - |
| `ANTHROPIC_API_KEY` | Auto-creates an `anthropic` provider on first init | - |
| `OPENAI_API_KEY` | Auto-creates an `openai` provider on first init | - |

## One-shot mode (CLI)

```bash
# Register a project from CLI (equivalent to /project init in REPL)
hk2 --mode=project-init --name=myapp --source=/path/to/repo --source-root=src

# Build KB for the current project
hk2 --mode=build-kb

# Incrementally update the KB
hk2 --mode=update-kb

# Enter the REPL with a specific project pre-selected
hk2 --project=myapp                       # by name
hk2 --project-id=8ce5c38d-214c-4e0d-8ed1-30045dd3c99d   # by UUID

# List all registered projects and exit (current marked with '*')
hk2 --project-list

# Legacy REPL (command-style, no agent loop)
hk2 --run-mode=serve
```

## Supported languages

The KB indexer prefers **native tree-sitter grammars** for AST-accurate symbol
extraction across 14 packages (15 grammars, since `tree-sitter-typescript`
exports both `typescript` and `tsx`):

- C, C++, C#
- JavaScript, TypeScript, JSX/TSX
- Python, Go, Rust
- Java, Kotlin, Scala
- Ruby, PHP
- Bash / Zsh

If a grammar or the `tree-sitter` native binding is unavailable, hk2 transparently
falls back to regex-based parsers (lower coverage, same Symbol[] shape). C/C++
and lex/yacc (`.y`/`.l`) sources additionally have dedicated regex parsers used
in the fallback path.

## Directory layout

```
hk2/
├── bin/
│   └── hk2                    # Single entry point (#!/usr/bin/env node)
├── install.sh                 # Installer (copies tree, symlinks bin, runs npm install)
├── src/
│   ├── cli.js                 # Argument parsing + dispatch (defaults to interactive)
│   ├── commands/
│   │   ├── interactive.js     # Default interactive REPL (agent loop + status bar)
│   │   ├── build_kb.js        # --mode=build-kb
│   │   ├── update_kb.js       # --mode=update-kb
│   │   ├── search.js          # Legacy serve-mode code search helper
│   │   ├── explain.js         # Legacy serve-mode explanation helper
│   │   └── serve.js           # --run-mode=serve (legacy REPL)
│   └── slash/
│       ├── index.js           # Slash command dispatcher (quote-aware tokenizer)
│       ├── model.js           # /model
│       ├── project.js         # /project
│       ├── kb.js              # /kb (incl. knowledge init/export/import/transform)
│       └── session.js         # /session
├── lib/
│   ├── config/
│   │   └── home.js            # $HOME/.hk2 config layer
│   ├── agent/
│   │   ├── loop.js            # Agent turn loop (stuck detection, tool cache)
│   │   ├── tools.js           # Tool registry + KbFirstGuard (incl. graph tools)
│   │   ├── system_prompt.js   # System prompt builder + KB policy
│   │   ├── graph.js           # Per-request knowledge graph builder
│   │   ├── statusbar.js       # persistent bottom status bar
│   │   └── transcript.js      # JSONL session transcript
│   ├── parser/
│   │   ├── ast.js             # AST dispatcher (tree-sitter → regex fallback)
│   │   ├── ts_parser.js       # Tree-sitter multi-language parser
│   │   ├── doc_parser.js      # Document parser (md/json/yaml/html/sgml/pdf/docx/doc/pptx/ppt)
│   │   ├── c_parser.js        # Legacy C parser (fallback)
│   │   ├── ylex_parser.js     # Legacy Y/L parser (fallback)
│   │   └── generic_parser.js  # Legacy regex parser for other languages (fallback)
│   ├── graph/
│   │   ├── builder.js         # Build nodes + edges from Symbol[]
│   │   └── traverse.js        # Pure BFS / call-chain helpers
│   ├── index/
│   │   ├── indexer.js         # Walk → parse → BM25 + callgraph + graph + Eden docs
│   │   ├── walker.js          # Glob walker (include/exclude + .gitignore)
│   │   ├── gitignore.js       # .gitignore loader
│   │   ├── checkpoint.js      # Resumable build checkpoint
│   │   ├── summarize.js       # LLM-authored Eden summaries
│   │   ├── bm25.js            # BM25 index
│   │   ├── callgraph.js       # Legacy callgraph (derived from graph)
│   │   ├── text_tokenizer.js  # Tokenizer for BM25
│   │   └── registry.js        # KB registration + PARSER_VERSION
│   ├── retrieval/             # KB retrieval + runtime cache (code_search, kb_runtime)
│   ├── llm/                   # LLM client (OpenAI / Anthropic, tool-call + usage)
│   ├── store/                 # KB storage (holy/eden/index/graph paths)
│   └── util/
└── package.json
```
