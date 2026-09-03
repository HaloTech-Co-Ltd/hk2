# Agent tools

English | [简体中文](../../zh-CN/reference/agent-tools.md)

Reference for the tools the hk2 agent can call mid-turn (OpenAI / Anthropic
native tool-calling). The registry lives in `lib/agent/tools.js` — when
editing this page, re-check it against that file. MCP tools attached to the
active model appear after the built-ins as `mcp__<server>__<tool>`.

## Index

| Category | Tools |
|---|---|
| Files | `read`, `write`, `edit` |
| Shell / search | `bash`, `find`, `grep` |
| Structural | `ast_grep`, `ast_edit`, `resolve` |
| Planning | `plan`, `plan_step` |
| KB query | `kb_search`, `kb_symbol`, `kb_outline`, `kb_neighbors`, `kb_callchain`, `kb_class`, `kb_refs`, `kb_implements` |
| KB knowledge | `kb_knowledge`, `kb_search_knowledge`, `kb_save_knowledge` |
| Session | `remember` |
| MCP | `mcp__<server>__<tool>` |

## File tools

### `read`

Read file contents — line-numbered, `offset`/`limit` for large files,
truncated at a line/KB cap (continue with `offset` until complete). Supports
text files and images (jpg, png, gif, webp, bmp) — images are sent as
attachments. For code files known to the KB, a structural `## Outline (from
KB)` section is prepended (`outline=false` disables); the result carries a
`tag` for stale-anchor protection. Writes: no.

### `write`

Create or overwrite a file; parent directories are created automatically.
Writes: yes.

### `edit`

Precise string replacement in a single file. Accepts
`{edits:[{oldText,newText}]}` (preferred — multiple disjoint edits in one
call) or `{old_string,new_string}` (single edit). Every `oldText` must match
a unique, non-overlapping region. Optional `tag` (shortHash from a prior
`read`/`kb_outline`) rejects the edit if the file changed since the tag was
minted. Writes: yes.

## Shell and search

### `bash`

Execute a shell command in the current working directory; returns stdout +
stderr (truncated), optional timeout in seconds. Permission-checked
best-effort (see [Security and permissions](../guides/security-and-permissions.md)).
Writes: potentially — treat as a writing tool.

### `find`

Glob-pattern file search; returns paths relative to the search directory,
truncated at 1000 results. Writes: no.

### `grep`

Regex content search; matching lines with file:line, truncated at 100
matches (long lines to 240 chars), covering up to 2000 files per call. Writes: no.

## Structural tools

### `ast_grep`

Structural code search, ast-grep style — the pattern is translated to a
regex approximation of the metavariable grammar (see
[Pattern syntax](#pattern-syntax-ast_grep--ast_edit)). Returns up to 50
matches across up to 2000 files. When the pattern is a single exact
identifier the KB knows, a kb-first hint points at `kb_symbol`. Writes: no.

### `ast_edit`

Structural rewrite across files. Each op is `{pat, out}` using the same
metavariable syntax (captures substitute into `out`). **Never writes to disk
itself**: it returns a unified-diff preview plus a `proposalId` and stashes
the writes. Optional `tag` validates target files at preview time. Writes:
staged only — applied via `resolve`.

### `resolve`

Two-phase commit for `ast_edit`: `action:"apply"` writes every staged file
(re-validating each content tag; rolls back on any failure);
`action:"discard"` drops the stash without writing. Writes: yes (on apply).

## Plan tools

### `plan`

Propose an execution plan for the user to confirm — the interface the triage
assistant calls when it decides the task is complex enough to warrant a
strategy decision. Takes a `summary` string and 2–5 ordered `steps`, each
with a `goal` and 2–4 candidate `strategies` ({name, description,
recommended} — exactly one recommended). The tool surfaces the plan for
per-step strategy selection (auto-accepting the recommended strategy in
non-interactive mode) and returns the finalized plan text; `{confirmed,
plan}` on acceptance, `{cancelled}` on cancel, `{error}` on an invalid
shape. Writes: no.

### `plan_step`

Mark a step of the currently confirmed plan complete and advance the live
progress panel. Call once after finishing each confirmed plan step; `step`
is 1-based (omit to advance the current step). No-op when no plan is active;
the panel clears automatically after the last step. Do not call before
`plan` returns a confirmed plan. Writes: no.

## KB query tools

All read directly from the index — no filesystem hit, no reparse. Content
that mirrors a denied source file is suppressed (metadata stays visible).

| Tool | Purpose |
|---|---|
| `kb_search` | Natural-language / keyword symbol search — BM25 + name-match reranking, with file paths, line ranges, snippets. Query is LLM-rewritten by default (`skip_rewrite=true` to skip); top-3 results carry a ±15-line source slice (`with_slice=false` to disable) |
| `kb_symbol` | Look up a symbol by exact identifier; all matching candidates |
| `kb_outline` | File outline from the KB index — name / kind / lines / signature / parent / child count per symbol; cheaper than `read` for "what's in this file?"; returns a `tag` for edit safety |
| `kb_neighbors` | Call-graph 1-hop neighbors of a symbol (legacy) |
| `kb_callchain` | Bounded DFS over the call graph — callers and/or callees up to `max_depth` hops, capped at `max_nodes` |
| `kb_class` | Class / interface / struct lookup: signature, doc string, members, super-classes, direct implementations |
| `kb_refs` | Reverse lookup: callers, importers, deriving classes (`kind=call\|import\|inherit\|any`) |
| `kb_implements` | Given an interface or base class, list every class / struct deriving from it |

## KB knowledge tools

| Tool | Purpose |
|---|---|
| `kb_knowledge` | Look up a knowledge entry by id — searches Holy and Eden, returns the full entry (title, intro, keyFiles, keySymbols, keywords, space) |
| `kb_search_knowledge` | Search both knowledge spaces by natural-language query (keyword-overlap ranking) — use to check whether the KB already documents a concept |
| `kb_save_knowledge` | Persist a knowledge entry to Holy (requires user approval) or Eden (auto-learn eligible); reloads into the in-memory KB immediately. Saving via this tool marks the turn's knowledge capture as handled |

## Session tools

### `remember`

Persist a short, self-contained session fact (environment endpoints and
addresses, ports, versions, account or machine names, deployment constraints,
explicit preferences like "always run tests with X"). The fact is injected
into every subsequent turn via a standing `## Session facts` system message
placed right after the main system prompt, and is **immune to context
compaction**. Writes: session facts file only.

Boundaries (enforced by the tool guidelines the model receives):

- One fact per call, phrased self-contained ("测试环境地址 10.1.2.3",
  "PostgreSQL 16.2", "用 npm 不用 yarn").
- Facts only — never secrets themselves. Reusable **code** knowledge belongs
  to `kb_save_knowledge`, not here; task steps and code findings are not
  facts.
- Max 100 facts per session, 500 characters each; a write refreshes the
  standing message so subsequent LLM calls in the same loop see it.
- Best-effort: a storage failure degrades to "no facts this turn" and never
  blocks the pipeline.

Users drive the same store via `/remember` / `/forget`; a compaction-time
extraction pass also rescues facts from turns about to be summarized away
(see [Agent workflow](../concepts/agent-workflow.md)).

## MCP tools

`mcp__<server>__<tool>` — tools from MCP servers attached to the active
model via `/model add-mcpserver` (e.g. `mcp__web-reader__webReader`). Each
agent turn attaches them after the built-ins; unreachable servers are
skipped with a warning. See
[Models, projects, and sessions](../guides/models-projects-and-sessions.md#mcp-servers).

## KB-first policy

Every code-discovery path favours the KB index over fresh parsing:

- `kb_outline`, `kb_symbol`, `kb_search`, and the graph tools read directly
  from the index — no filesystem hit, no reparse.
- `read` on a code file prepends the KB-sourced outline so the agent sees
  structure before content.
- `bash grep/find/cat` and direct `read` calls without a prior KB tool get a
  one-time `[kb-first policy hint]` prepend; after the agent uses any KB
  tool the hint stops, signalling that subsequent bash/read fallbacks are
  intentional.
- `ast_grep` with a single exact identifier emits the same hint toward
  `kb_symbol`.

When the agent still falls back to bash searches, the end-of-turn
`[kb update]` offer (or silent auto-update under `HK2_ENABLE_AUTOUPDATEKB`)
re-syncs the index.

## Pattern syntax (`ast_grep` / `ast_edit`)

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

## Stale-anchor protection (`tag`)

`read` and `kb_outline` results include a `tag` — the first 8 hex chars of
the file's content hash. Echo it into subsequent `edit` or `ast_edit` calls
and the tool rejects the change if the file was modified since the tag was
minted:

```text
read({path:"src/foo.js"}) → {tag:"a1b2c3d4", ...}
edit({path:"src/foo.js", old_string:..., new_string:..., tag:"a1b2c3d4"})
  → ok on match, error: "stale tag: file changed since read..." on mismatch
```

`resolve` re-validates tags at apply time and rolls back on any failure.

## Deferred capabilities

The following are intentionally **not** implemented yet — they lack a clean
kb-first story and require multi-thousand-line integrations:

- **LSP integration** — language servers, JSON-RPC negotiation, diagnostics
  streaming. The KB symbol index already covers most "what does the IDE
  know?" queries; LSP would add live diagnostics and cross-file renames.
- **DAP debugging** — debug adapters (gdb, lldb-dap, debugpy, dlv),
  breakpoint/step/variable protocols. Same scope as LSP.
- **Full hashline grammar** (`SWAP.BLK`, `INS.PRE/POST/HEAD/TAIL`, `MV`,
  `REM`) — v1 ships only the `tag` safety mechanism; the full line-anchored
  grammar waits until the preview/accept flow is proven.
- **AST-exact ast_grep matching** — v1 uses a regex approximation
  (metavariables → capture groups). Full ast-grep pattern parity (true AST
  boundary matching) is iterative.

## Related documentation

- [Slash commands](slash-commands.md) — what *you* can call
- [Knowledge graph and retrieval](../concepts/knowledge-graph-and-retrieval.md) — what the KB tools query
- [Security and permissions](../guides/security-and-permissions.md) — which tools are permission-checked and how
