<img width="886" height="223" alt="Screenshot 2026-08-23 at 09 02 34" src="https://github.com/user-attachments/assets/f64c2197-5301-46d2-8984-d659dac5e556" />


# hk2

A knowledge-base (KB) driven agent, purpose-built for coding.
- **DESIGN PHILOSOPHY:** make the KB the central source of truth for every project.
- **THE CORE GOAL:** an agent that gets smarter and more useful the more you use it.

Every session's discoveries are distilled into durable knowledge, so it starts each new task already knowing what the last one learned.

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
/kb knowledge learn

#    or deep-study documents (PDF / Word / PPT / Markdown) into a space:
/kb knowledge learn --space=eden --file=docs/spec.pdf

#    or scope the code study to one subdirectory:
/kb knowledge learn --base-dir=src/storage

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

### Project Supreme Code (`hk2-supreme-code`)

Every project's Holy Space carries one **permanent, protected entry** — `hk2-supreme-code` — holding the project's *fundamental laws*: short, imperative rules that EVERY hk2 operation (reading, writing, editing, planning, answering) must obey and can never violate. It is created **empty** by `/kb init` (legacy projects get an empty shell auto-created), so nothing is enforced until you write laws into it.

- **Design purpose**: a single, always-visible place for the project owner to encode non-negotiable constraints — security policies, coding standards, compliance requirements — that outrank the agent's general preferences and every other KB entry.
- **Injection**: on each request the items are rendered into the system prompt as a `# Project Supreme Code (MUST OBEY — never violate)` section placed *before* the KB knowledge-graph context. If an operation would violate any item, the agent must refuse it, cite the item's number, and propose a compliant alternative.
- **Protection**: the entry itself can never be deleted, renamed, moved, emptied, imported over, or auto-updated — enforced at both the command layer and the storage layer.

Usage (the only way to modify it; every write requires an explicit y/N confirmation):

```
/kb code list                                # show all items
/kb code add --code-content="API keys are strictly forbidden in any code file"
/kb code add 1 --code-content="..."          # update item 1 in place
/kb code add --code-gen="draft one rule about commit message format"
/kb code del 2                               # delete item 2; later items shift up
```

Limits: max **100 items**, **200 characters** each, numbered 1..N with no gaps (`/kb code add` without an id appends as item N+1; an id > N+1 is rejected). Keep items short and imperative — genuinely complex rules belong in their own Holy entry, referenced from a code item as `**KB(entry-id)**`. `/kb status` shows the current count.

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

`/kb init` and `/kb knowledge learn` produce complementary sets of LLM-authored Eden entries. None require manual writing — both commands overwrite prior versions on each run.

**`/kb init`** writes 3 high-level structural entries (skipped with `--skip-summary`):

| Entry id | Contents |
|---|---|
| `project-overview` | 600–900-word prose summary: what the project does, high-level architecture, key modules, notable patterns. |
| `architecture-diagram` | A Mermaid flowchart of module / layer relationships with a short legend. |
| `architecture-decisions` | 4–8 ADR-style entries inferred from detected technologies, each with concrete modification suggestions. |

**`/kb knowledge learn`** is the unified deep-study command (it absorbed the former `/kb knowledge init`, which now aliases to it). It has two modes. **CODE mode** (no `--file`; `--base-dir` matching an indexed subdirectory, or bare) writes 3 project-wide survey entries as Phase 0, then N topic-specific entries as Phase 2. **DOC mode** (`--file=<path>` or a non-indexed `--base-dir`) deep-studies Markdown / PDF / Word / PowerPoint documents into the chosen space:

| Entry id | Phase | Contents |
|---|---|---|
| `api-docs` | 0 | Numbered reference for the most important public / exported symbols across the whole project. |
| `code-walkthrough` | 0 | 4–8 sections walking through the most central core abstractions. |
| `usage-examples` | 0 | 3–5 numbered quickstart examples using real public symbols. |
| `<topic-id>` (dynamic) | 2 | One entry per LLM-planned topic, each focused on a coherent subsystem (e.g. `buffer-pool`, `transaction-mgmt`, `wal-replay`). |

DOC mode (`--file` / non-indexed `--base-dir`) extracts entries from documents; large files are split into sequential parts so nothing is silently truncated, and every document is guaranteed to be covered by a batch (the planner's omissions get single-file fallback batches).

**Scale behavior (large projects like postgres, ~3500 files):** above 300 indexed files the planner switches from file-level to **directory-level planning** — the LLM groups directories (a ~30x smaller map), and each directory token is deterministically expanded into its concrete files, split into ≤30-file batches. If the LLM plan is still unusable (reasoning models can spend their whole budget thinking), the command retries once with reasoning disabled and finally falls back to deterministic directory grouping — the study always proceeds with full file coverage.

**Plan timeouts:** slow providers can exceed the default 300s planning budget; override with `--plan-timeout-ms=N` (or `HK2_PLAN_TIMEOUT_MS`).

Retrieve any of them via `kb_knowledge("<id>")` or `kb_search_knowledge("overview")`.

### Knowledge commands

| Command | Description |
|---|---|
| `/kb knowledge list [--space=holy\|eden]` | List knowledge entries |
| `/kb knowledge show <id>` | Show full entry (searches both spaces) |
| `/kb knowledge add [--space=holy\|eden] [--id=...] --title="..." [--intro="..." \| --intro-file=PATH] [--key-files=...] [--key-symbols=...] [--keywords=...]` | Manually add an entry |
| `/kb knowledge learn [--space=eden\|holy] [--file=PATH] [--base-dir=DIR] [--per-batch-chars=N] [--dry-run] [--no-survey] [--model=<provider>/<model-id>] [--plan-timeout-ms=N]` | Unified deep-study command; `--model` drives every learn LLM call (Phase 0 survey / Phase 1 planning / Phase 2 extraction / validation) with the given registry model instead of the current session model. CODE mode (bare, or `--base-dir` matching an indexed subdirectory): two-phase deep-study of indexed source files; Phase 0 writes the three project-wide survey entries; Phase 1 plans topic batches (scale-aware for large projects like postgres), Phase 2 executes each batch. Falls back to deterministic directory grouping when the LLM plan is unusable — never aborts. DOC mode (`--file` or a non-indexed `--base-dir`): deep-study Markdown / PDF / Word / PowerPoint / text documents into `--space`. Legacy `init`/`bootstrap`/`scan` aliases route here (whole-project CODE mode). |
| `/kb knowledge export <eden\|holy\|all> <path>` | Export entries to a JSON file (version 2 format with per-entry `space` tags) |
| `/kb knowledge import <path> [eden\|holy\|adaptive] [--overwrite]` | Import entries from JSON. `adaptive` routes each entry to its original space. Holy imports always prompt y/N. |
| `/kb knowledge housekeep <eden\|holy\|all> [--model=<provider>/<model-id>]` | LLM-assisted: remove broken entries, merge duplicate/similar entries (y/N); with `all`, resolve Eden↔Holy conflicts via a per-pair choice menu. Supreme-code never touched; knowledge indexes rebuilt on change. |
| `/kb knowledge empty <eden\|holy\|all>` | Remove ALL entries from the specified space(s). Irreversible, always prompts y/N. |
| `/kb knowledge del <id>` | Delete an entry (requires confirmation) |
| `/kb transform <id> <from> <to>` | Move an entry between Holy and Eden (requires confirmation) |

## REPL command reference

Type `/help` for the full list, or `/help <command>` (e.g. `/help kb`, `/help knowledge`) for detailed usage and parameters of a single command. Every family also supports `<command> help` (e.g. `/model help set`, `/kb knowledge help learn`). Common commands:

| Command | Description |
|---|---|
| `/model list` | List all providers / models |
| `/model add <prov> <id> [--api=...] [--base-url=...] [--api-key=...] [--reasoning] [--context-window=N] [--max-tokens=N] [--temperature=N] [--name=NAME] [--model-type=TYPE] [--model-options=JSON]` | Add a model (`--model-options` sets model-specific feature options as a JSON object, e.g. `--model-options='{"enable_thinking":true}'`; default is no options; model types with declared features validate the options — e.g. `--model-type=glm-5.3` accepts `{"reasoning_effort":"max"}` with max (deep reasoning) the default/recommended, or high (enhanced) / low (light)) |
| `/model set <prov>/<id> [--name=...] [--id=NEW_ID] [--reasoning=on\|off] [--context-window=N] [--max-tokens=N] [--temperature=N] [--model-options=JSON] [--api=...] [--base-url=...] [--api-key=...]` | Modify a model's persisted settings (`--id` renames the model id / ref; the wire model code sent to the API is unaffected; `--model-options` replaces the model-specific options object wholesale — pass `'{}'` to clear; validated against the model type's declared features, e.g. glm-5.3 `reasoning_effort` ∈ max/high/low) |
| `/model set-default <prov>/<id>` | Set global default (persisted) |
| `/model set-default current <prov>/<id>` | Set the current project's default model (overrides the global default; `--clear` removes the override) |
| `/model use <prov>/<id>` | Choose model for current session only |
| `/model set-phase --phase=<name> <prov>/<id> [--clear]` | Per-project model override for one agent phase (`rewrite-query`, `request-assess`, `plan-review`, `code-review`); `--clear` removes the override so the phase falls back to the session model |
| `/model add-mcpserver <prov>/<id> --type=http --name=<NAME> [--options=JSON]` | Attach an MCP server to an existing model; its tools appear to the agent as `mcp__<name>__<tool>`. `http` options: `{"url":..., "headers":{"Authorization":"Bearer $APIKEY"}}` (`$APIKEY` is substituted with the provider's `--api-key` at use time) |
| `/model del <prov>/<id>` | Delete |
| `/model show` | Show current default details |
| `/model types` | List all supported `--model-type` values |
| `/model help [sub]` | Full `/model` usage; `/model help set` drills into one subcommand |
| `/project init --name=... --source=... [--source-root=...]` | Register a new project |
| `/project list` | List all projects |
| `/project set current <id\|name>` | Switch current project |
| `/project set name <new-name>` | Rename |
| `/project show` | Current project details |
| `/project drop <id\|name>` | Remove a project (KB preserved) |
| `/kb init [--full] [--checkpoint-interval=N] [--no-resume] [--no-checkpoint] [--skip-summary]` | Build KB for current project (resumable, auto-generated summaries) |
| `/kb update` | Incremental update (Index Space); auto-detects a legacy KB and upgrades it to the current layout losslessly (knowledge snapshot to `backup/pre-upgrade-<ts>/` first, then includeGlobs / supreme-code / doc-graph / parser-version fixes; a parser-version change triggers a full re-index) |
| `/kb status` | KB statistics (per-space counts) |
| `/kb search <query> [--top-k=N]` | BM25 + reranking symbol search |
| `/kb symbol <name>` | Look up symbol by exact name |
| `/kb neighbors <symbol_id>` | Call-graph neighbors |
| `/kb knowledge list` | List Holy + Eden entries |
| `/kb knowledge show <id>` | Show full entry |
| `/kb knowledge add [...]` | Manually add an entry |
| `/kb knowledge learn [--dry-run] [--base-dir=PATH] [--file=PATH] [--space=eden\|holy] [--per-batch-chars=N] [--no-survey] [--plan-timeout-ms=N]` | Deep-study project code (or one subdirectory / documents) → auto-generate knowledge. Full flag docs: `/help knowledge` |
| `/kb knowledge export <scope> <path>` | Export entries to JSON |
| `/kb knowledge import <path> [eden\|holy\|adaptive] [--overwrite]` | Import entries (adaptive routes by original space) |
| `/kb knowledge housekeep <scope>` | LLM-assisted dedup/merge + conflict resolution |
| `/kb knowledge empty <scope>` | Remove ALL entries from space(s) |
| `/kb knowledge del <id>` | Delete entry |
| `/kb transform <id> <from> <to>` | Move between Holy and Eden |
| `/kb drop` | Delete KB (confirm required) |
| `/session info` | Current session id, project, message count |
| `/session list` | Recent sessions |
| `/session new` | Start a new session |
| `/session resume <id>` | Resume a previous session |
| `/review code` | Manually regression-check the just-completed task (code phase; `plan` reserved). The reviewer's thinking stream (`✎ thinking`) and analysis — requirement re-analysis, per-point coverage check, correctness check, conclusion — stream live; an unparseable verdict is reported as UNKNOWN, never as "no issues found" |
| `/theme` | List current tool-card frame colors vs built-in defaults |
| `/theme set <key> <color>` | Customize tool-card border/title colors, persisted (`key`: `bash`, `kb_*`, `*`, or an exact tool name like `read`; `color`: `#rrggbb`, `ansi:0-255`, or a built-in token `accent`/`muted`/`dim`/`success`/`error`/`warning`/`border`/`bashMode`/`pythonMode`; resolution priority: exact tool name > group key > `*` wildcard > built-in default) |
| `/theme reset [key]` | Drop one custom color, or the whole custom theme with no arg |
| `/theme preview` | Print sample tool cards for the three built-in groups with current colors |
| `/theme title-follow [on\|off]` | Toggle the top-border title following the frame color instead of the fixed muted hue |
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
| `mcp__<server>__<tool>` | Tools from MCP servers attached to the active model via `/model add-mcpserver` (e.g. `mcp__web-reader__webReader`). Each agent turn attaches them after the built-ins; unreachable servers are skipped with a warning |

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
an LLM re-analyzes the requirement, checks the plan for coverage (every needed
part delivered), ordering, feasibility, risks, and unstated assumptions, and
surfaces any issues one-by-one for confirmation before execution begins. The
reviewer's thinking stream (reasoning_content) renders live as `✎ thinking`
(dim italic, capped at 9 lines by default — set `HK2_HIDE_THINKING=0` for the
full stream), followed by its analysis, which also streams live; an
unparseable verdict is reported as
UNKNOWN, never as "no issues found"; see the env-var table. Reviews always
run with reasoning enabled and no fixed timeout — the reviewer waits for the
LLM to finish (the user can still abort), so a deep review is never cut off
mid-reply.

When `HK2_ENABLE_CODEREVIEW=1` (default off), after the entire plan finishes
executing, hk2 runs a Code Review step that checks the completed result — the
working-tree diff, the changed files, and the agent's final summary — for
correctness, completeness, and quality. The reviewer's thinking stream
(reasoning_content) renders live as `✎ thinking` (dim italic, capped at 9
lines by default — set `HK2_HIDE_THINKING=0` for the full stream), followed
by its analysis (plan re-analysis, per-point coverage check, correctness
check, conclusion), which streams
live while it reviews; any issues it finds are then listed one-by-one with
detail and a suggestion. A reply whose JSON verdict cannot be parsed is
reported as UNKNOWN, never as "no issues found". The review model is
configurable via `/model set-phase --phase=code-review <ref>` (same mechanism
as `plan-review`); when unset it uses the session model. See the env-var
table. Like plan review, it always runs with reasoning enabled and no fixed
timeout — the reviewer waits for the LLM to finish (the user can still
abort).

### Typing while a task runs

You can keep typing while the agent is working. Plain text entered mid-task is
queued (echoed as `✓ queued #N · delivered after the current action`) and
injected into the RUNNING conversation at the agent loop's round boundary —
after the current action (the LLM call plus all of its tool calls) completes,
before the next LLM call starts. The model receives them as in-task guidance
("fold into the work in progress, do not restart from scratch"), so the
current action is never disturbed. Slash commands keep the legacy behavior
(they run after the turn ends, since they may switch model / KB / project
state the in-flight turn still depends on); plan-confirmation menus are
unaffected. If the task finishes before a queued instruction can be delivered
mid-run, it is handed to a fresh turn right after — nothing you type is lost.

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
the hint on `id` and the clean code on `name` avoids "model code does not
exist" errors (e.g. BigModel's `[modelCode: not found]`) on gateways that
reject `glm-4.7[1m]`.

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
| `HK2_ENABLE_REQUEST_ASSESS` | When 1 (and `HK2_ENABLE_QUERYREWRITE=1`), hk2 first asks the LLM whether a user request is clear. If not, it surfaces the unclear aspects plus candidate interpretations as a numbered menu (with a free-text "something else" option) and feeds the chosen clarification back into the query rewrite. The assessment model is configurable via `/model set-phase --phase=request-assess <ref>` (same mechanism as `rewrite-query`); when unset it uses the session model. Active only in interactive TTY mode; one bounded round. Best-effort: any failure falls through to the normal rewrite. | `1` |
| `HK2_ENABLE_PHASEMODEL_FALLBACK` | What to do when a phase model configured via `/model set-phase` (e.g. `rewrite-query`, `request-assess`) is unreachable (connection refused / timeout / HTTP error). `1`: print a warning and re-run the phase on the current session (main) model so the phase still completes. `0`: print a warning and skip the phase entirely (the rewrite falls back to the raw query; the assessment round is skipped). Never silently succeeds: a dead phase model always produces a warning, and `phaseModelFallback` is recorded in the session transcript for auditing. Applies to `rewrite-query` and `request-assess` only — the review phases (`plan-review`, `code-review`) always skip on an unreachable model (warning printed, never a fallback), since silently substituting a model would change what reviewed the plan/code; `skipped` + `error` are recorded in the transcript. | `1` |
| `HK2_ENABLE_PLANREVIEW` | When 1, after the user confirms a plan, hk2 asks an LLM to review the finalized plan before execution begins. The reviewer re-analyzes the requirement as a numbered checklist, then checks per-point coverage (which step covers each requirement, complete/partial/missing), ordering and contradictions, feasibility of each chosen strategy, and unstated risks/assumptions. The analysis streams live; issues are surfaced one-by-one for confirmation (accept the reviewer's suggestion / dismiss / type your own) and the confirmed resolutions are appended to the plan returned to the agent. An unparseable JSON verdict is reported as UNKNOWN, never as "no issues found". The review model is configurable via `/model set-phase --phase=plan-review <ref>` (same mechanism as `rewrite-query`); when unset it uses the session model. Active only in interactive TTY mode. Best-effort: any failure returns the already-confirmed plan unchanged. | `0` |
| `HK2_ENABLE_CODEREVIEW` | When 1, after the entire plan finishes executing, hk2 runs a Code Review step on the completed result (working-tree diff, changed files, and the agent's final summary) for correctness, completeness, and quality. The reviewer's analysis (plan re-analysis, per-point coverage check, correctness check, conclusion) streams live; issues are then listed one-by-one with detail and a suggestion. An unparseable JSON verdict is reported as UNKNOWN, never as "no issues found". The review model is configurable via `/model set-phase --phase=code-review <ref>` (same mechanism as `plan-review`); when unset it uses the session model. Active only in interactive TTY mode. Best-effort: any failure is reported and the turn ends normally. | `0` |
| `HK2_ENABLE_AUTOUPDATEKB` | When 1, hk2 silently runs an incremental `/kb update` (Index Space) at end of any turn where the agent fell back to bash to search source files. | `0` |
| `HK2_ENABLE_AUTO_LEARN` | When 1, hk2 silently asks the model to extract a reusable knowledge entry from the just-finished conversation and saves it to Eden Space. Holy Space ALWAYS prompts y/N regardless of this flag. | `0` |
| `HK2_KB_LEARN_COOLDOWN_MIN` | When a positive number of minutes, the end-of-turn `[kb learn]` fallback is skipped while a knowledge capture for this session's task was handled within that window (an agent `kb_save_knowledge` save/decline, an answered end-of-turn proposal, or the extraction model's skip). The anchor is restored across `--resume` from the transcript. When the agent already saved knowledge via `kb_save_knowledge` this turn, `[kb learn]` is ALWAYS skipped regardless of this variable. | `0` (OFF) |
| `HK2_KB_LEARN_VALIDATE` | When 1, before an end-of-turn `[kb learn]` entry is written, hk2 validates it against existing KB entries (id/title/keyword pre-filter + one semantic LLM check): essentially-identical content is skipped (no duplicate learning), related entries are UPDATED in place via a merged intro, and direct conflicts are resolved — Holy conflicts ALWAYS defer to the user, Eden conflicts follow the validator's winner with the reason printed. Creating a new entry beside related ones prints the reason it was not an update. Validation is best-effort: any failure falls through as a normal new entry. | `1` |
| `HK2_ENABLE_AUTOCOMPACT` | When 1, hk2 auto-compacts the prior conversation at the start of a turn once the measured context length reaches `HK2_AUTOCOMPACT_PCTUSED`% of the model's context window. Compaction keeps the last 4 user/assistant turns verbatim and LLM-summarizes earlier turns (including their tool results) into a single system message, falling back to naive truncation if the LLM fails. Runs only at the turn boundary, never mid-turn. | `0` |
| `HK2_AUTOCOMPACT_PCTUSED` | Integer 1-100 context-usage threshold percentage. Auto-compaction only triggers when the measured context length ≥ `model context window × HK2_AUTOCOMPACT_PCTUSED / 100`. | `90` |
| `HK2_KB_CHECKPOINT_INTERVAL` | Save `/kb init` checkpoint every N files | `100` |
| `HK2_PLAN_TIMEOUT_MS` | `/kb knowledge learn` Phase 1 planning call timeout in ms. Slow providers (reasoning models on large file maps) can exceed the default 300s. Per-run override: `--plan-timeout-ms=N`. | `300000` |
| `HK2_INDEX_PARALLEL` | Parallelism of the KB index parse pool (`/kb init` / `/kb update`). `0` or unset = auto (host CPU count); a positive integer pins the width. | `0` |
| `HK2_DEBUG` | Print error stacks | - |
| `HK2_NO_COLOR` | When 1, disable ANSI colors (also honors the standard `NO_COLOR` env var). | - |
| `HK2_ASCII` | When 1, force ASCII fallbacks for box-drawing / spinner / icons instead of UTF-8 glyphs (useful on non-UTF-8 terminals). | - |
| `HK2_HIDE_THINKING` | When unset or `1` (default), the `✎ thinking` reasoning window renders at most 9 content lines, then a dim notice reports how many lines were hidden. When `0`, the full reasoning stream is rendered (previous behavior). | `1` |
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
│       ├── kb.js              # /kb (incl. knowledge learn/export/import/transform)
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
