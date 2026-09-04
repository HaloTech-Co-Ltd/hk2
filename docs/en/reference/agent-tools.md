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

Read **UTF-8 text** files — no image or binary content support. Files larger than **5 MiB** are
rejected outright (`file too large: N bytes` — pagination cannot help).
Below that, output is line-numbered and capped at 2000 lines or roughly
256 KiB at line boundaries — except that the first requested line is still
emitted even when that one line exceeds the nominal byte cap; continue
with `offset`/`limit`. Files whose first 8192
decoded characters contain a NUL byte are rejected as binary
(`binary file (NUL byte detected): … — read only supports text files`) —
this is a NUL-scan heuristic, not full binary-format detection. For
eligible indexed source files, a structural `## Outline (from KB)` section is
prepended (`outline=false` disables) and the result may carry a `tag` for
stale-anchor protection (see [Stale-anchor protection](#stale-anchor-protection-tag));
eligibility follows the tool registry's recognized-extension whitelist
(`SOURCE_EXT_RE`), which is narrower than the indexer's full parser/doc
support — e.g. `.cs`, `.kts`, `.sgml`, `.doc`, `.ppt`, and `.pptx` are
indexed but not outline/tag-eligible, and extension-less convention files
(README/LICENSE/...) are never tag-eligible. Files outside the whitelist
are still indexed; they just get no outline prepend or tag from `read`, Writes: no.

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
Optional timeout in seconds: default 60, hard-capped at 60 (larger values
are clamped; `0` falls back to the default). Writes: potentially — treat as
a writing tool.

### `find`

Glob-pattern file search; returns paths relative to the search directory,
truncated at 1000 results. The internal walker skips `.git` and
`node_modules` but does **not** evaluate the repository's `.gitignore`.
Writes: no.

### `grep`

Regex content search; matching lines with file:line, truncated at 100
matches (long lines to 240 chars), covering up to 2000 files per call. The
internal walker skips `.git` and `node_modules` but does **not** evaluate
the repository's `.gitignore`. Writes: no.

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
the writes. The optional `tag` is compared against **every** target file, so
one tag applies to all files — it mainly suits single-file rewrites; for
multi-file proposals omit the tag and rely on the per-file re-validation at
`resolve` time. Writes: staged only — applied via `resolve`.

### `resolve`

Two-step preview/apply flow for `ast_edit`: `action:"apply"` writes every
staged file (re-validating the per-file tags the proposal recorded at
preview time); on a failure it **attempts** to restore the already-written
files from their previous contents — rollback is best-effort,
non-transactional (a rollback write that itself fails is currently ignored
and not separately surfaced). `action:"discard"` drops the stash without
writing. Writes: yes (on apply).

**Proposal lifecycle**: proposals live in process memory only — lost on
exit or crash, expiring after a 10-minute TTL, capped at 16 active
proposals per process (LRU eviction beyond that). Re-using an expired,
evicted, failed, or already-resolved id errors out; run `ast_edit` again
for a fresh proposal.

**Known limitation**: `ast_edit`'s directory expansion walks at most 2000
candidate files per root and does not report the truncation in its result —
a proposal over a very large tree may silently cover only the first 2000
walked files. Narrow `paths` when targeting big trees.

## Plan tools

### `plan`

Propose an execution plan for the user to confirm — the interface the triage
assistant calls when it decides the task is complex enough to warrant a
strategy decision. Takes a `summary` string and an intended shape of 2–5
ordered `steps`, each with a `goal` and 2–4 candidate `strategies`
({name, description, recommended} — exactly one recommended) — the
recommended shape the prompt asks for; runtime validation enforces only a
minimum of two usable steps and two usable strategies per step, with no
maximum. The tool surfaces the plan for
per-step strategy selection (auto-accepting the recommended strategy in
non-interactive mode) and returns the finalized plan text; `{confirmed,
plan}` on acceptance, `{cancelled}` on cancel, `{error}` on an invalid
shape. Writes: no.

### `plan_step`

Advance the live progress panel by marking the CURRENT in-progress step of
the confirmed plan as done — call once after finishing each step. The
`step` parameter is retained only as a compatibility/reporting hint: the
interactive state machine always advances the current in-progress step, and
the value never selects an arbitrary step (invalid, out-of-range, or
out-of-order values change nothing). No-op when no plan is active; the
panel clears after the last step, and a normal turn end finalizes any panel
left un-advanced as a backstop. Do not call before `plan` returns a
confirmed plan. Writes: no.

## KB query tools

Most symbol and graph metadata comes from the loaded in-memory KB index, but
this is not a blanket no-filesystem guarantee: `kb_search` loads source
slices from disk by default, and `kb_knowledge` may fall back to the on-disk
knowledge store (directly, when `space` is given, or on a runtime-cache
miss). Content that mirrors a denied source file is suppressed in the
filtered channels (metadata stays visible — see
[Security and permissions](../guides/security-and-permissions.md)).

| Tool | Purpose |
|---|---|
| `kb_search` | Natural-language / keyword symbol search — BM25 + name-match reranking, with file paths, line ranges, snippets. Query is LLM-rewritten by default when an LLM is available (`skip_rewrite=true` to skip); top-3 results carry a ±15-line source slice (`with_slice=false` to disable). `top_k`: default 10, clamped to an effective range of 5–50 (values below 5 still return at least 5) |
| `kb_symbol` | Look up a symbol by exact identifier; all matching candidates |
| `kb_outline` | File outline from the KB index — name / kind / lines / signature / parent / child count per symbol; cheaper than `read` for "what's in this file?"; returns a `tag` for edit safety |
| `kb_neighbors` | Legacy one-hop **outgoing** call-graph neighbors of a symbol (what it calls; no direction parameter — use `kb_callchain` with `direction=backward`/`both` for callers) |
| `kb_callchain` | Bounded BFS over the call graph — callers and/or callees up to `max_depth` hops. `max_nodes` applies independently to each selected direction; the BFS budget includes the starting node (omitted from the results), so each direction returns at most `max_nodes - 1` other nodes |
| `kb_class` | Class / interface / struct / enum lookup: signature, doc string, members, super-classes, direct implementations |
| `kb_refs` | Reverse lookup: callers, importers, deriving classes (`kind=call\|import\|inherit\|any`) |
| `kb_implements` | Given an interface or base class, list its DIRECT implementers / direct subclasses recorded by the graph (one hop, not a transitive closure — query results again to walk deeper) |

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
extraction pass also *attempts* to preserve facts from turns about to be
summarized away — that extraction is best-effort (see
[Agent workflow](../concepts/agent-workflow.md)).

## MCP tools

`mcp__<server>__<tool>` — tools from MCP servers attached to the active
model via `/model add-mcpserver` (e.g. `mcp__web-reader__webReader`). Each
agent turn attaches them after the built-ins; unreachable servers are
skipped with a warning. See
[Models, projects, and sessions](../guides/models-projects-and-sessions.md#mcp-servers).

## KB-first policy

Every code-discovery path favours the KB index over fresh parsing:

- `kb_outline`, `kb_symbol`, and the graph tools read from the loaded
  in-memory index. `kb_search` also ranks via BM25 from the index, but by
  default loads a ±15-line source slice for the top 3 results **from the
  filesystem** (skipped for files over 512 KiB, bounded by read
  permissions; disable with `with_slice=false`).
- `read` on a code file prepends the KB-sourced outline so the agent sees
  structure before content.
- `bash grep/find/cat` and direct `read` calls get a
  `[kb-first policy hint]` prepend while no KB tool has run yet in that LLM
  call — at most one hint per LLM call for each of: bash, read, and the
  shared standalone-search bucket (find / grep / generic ast_grep share one
  bucket). Once any KB tool runs, the generic hints stop for the rest of
  that LLM call, signalling that subsequent bash/read fallbacks are
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

Three distinct things are called a "tag" — keep them apart:

1. **The index-snapshot tag returned by `read` / `kb_outline`** — the first
   8 hex chars of the file hash **recorded in the KB file registry at
   indexing time** (not a hash recomputed from the just-read bytes; files
   outside the index, or outside the tool registry's recognized-extension
   whitelist, get no tag).
2. **A user-passed tag on `edit`** — `edit` compares that snapshot tag
   against a fresh hash of the current on-disk content, so a stale index
   (file changed since the last `/kb init`/`update`) can reject a valid
   edit even though the file did not change after your read.
3. **The user-passed single tag on `ast_edit`** — compared against every
   target file (see `ast_edit` above; single-file rewrites only). Separately
   from any user tag, `ast_edit` records its own per-file hash for each
   proposal, and `resolve` re-validates those per-file tags at apply time. `edit`
compares it against a hash of the current on-disk content, so a stale index
(file changed since the last `/kb init`/`update`) can reject a valid edit —
run `/kb update` and read/kb_outline again to refresh the indexed tag, or
omit the tag in that case. Echo it into subsequent `edit` calls (single-file
`ast_edit` only)
and the tool rejects the change if the file was modified since the tag was
minted:

```text
read({path:"src/foo.js"}) → {tag:"a1b2c3d4", ...}
edit({path:"src/foo.js", old_string:..., new_string:..., tag:"a1b2c3d4"})
  → ok on match, error: "stale tag: file changed since read..." on mismatch
```

`resolve` re-validates the per-file tags the proposal recorded at preview
time; on failure it attempts to restore already-written files —
best-effort, non-transactional (a rollback write that itself fails is
currently ignored and not separately surfaced).

**Proposal lifecycle**: proposals live in process memory only — they are
lost on exit or crash, expire after a 10-minute TTL, and are capped at 16
active proposals per process (LRU eviction beyond that). Re-using an
expired, evicted, failed, or already-resolved id returns an
unknown/expired-style error; run `ast_edit` again to mint a fresh proposal.

**Known limitation**: `ast_edit`'s directory expansion walks at most 2000
candidate files per root and currently does **not** report the truncation
in its result — a proposal over a very large tree may silently cover only
the first 2000 walked files. Narrow `paths` when targeting big trees.

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
