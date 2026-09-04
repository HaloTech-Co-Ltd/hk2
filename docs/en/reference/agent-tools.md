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
stale-anchor protection (see [Stale-anchor protection](#stale-anchor-protection-tag)).
`read` auto-annotation requires `outline !== false`, a loaded KB runtime, the
original path matching the tool registry's `SOURCE_EXT_RE` heuristic whitelist,
and an exact raw-path hit in the KB file table. The whitelist is narrower than
the indexer's full parser/doc support: `.cs`, `.kts`, `.sgml`, `.doc`, `.ppt`,
`.pptx`, and extension-less convention files are outside it (the whitelist
conversely includes `.md`/`.json`/`.pdf`). A tag additionally needs a stored
hash; an outline needs at least one symbol. Absolute or differently-spelled
paths may miss the project-relative key. A direct `kb_outline` call does not
use `SOURCE_EXT_RE`: any indexed file can be queried, including `.cs`/`.kts`,
and it may return an empty outline with a valid tag when no symbol exists. Writes: no.

### `write`

Create or overwrite a file; parent directories are created automatically.
Writes: yes.

### `edit`

Precise string replacement in a single file. Accepts
`{edits:[{oldText,newText}]}` (preferred — multiple disjoint edits in one
call) or `{old_string,new_string}` (single edit). Multi-edit entries run sequentially
in array order against evolving in-memory content; each `oldText` must be unique at
that point, and later entries may match text produced by earlier entries. If a
later entry fails, the file is not written. Optional `tag` (shortHash from a prior
`read`/`kb_outline`) rejects the edit when the current file hash differs from
the supplied KB-index snapshot tag. Writes: yes.

## Shell and search

### `bash`

Execute a shell command in the current working directory. stdout and stderr
are each independently truncated to an approximately 8 KiB budget (there is
no 2000-line limit; a KB hint in stderr consumes that stderr budget). The
optional timeout defaults to 60 seconds and is capped at 60; larger values are
clamped, `0` falls back to default, and negative values are not validated — do
not use them. Permission check is best-effort (see [Security and permissions](../guides/security-and-permissions.md)). Writes: potentially — treat as a writing tool.

### `find`

Glob-pattern file search; returns paths relative to the search directory,
truncated at 1000 results. The internal walker skips `.git` and
`node_modules` but does **not** evaluate the repository's `.gitignore`.
Writes: no.

### `grep`

Textual regex search by default (set `literal=true` for literal matching); matching lines with file:line, truncated at 100
matches (long lines to 240 chars), covering up to 2000 files per call. The
internal walker skips `.git` and `node_modules` but does **not** evaluate
the repository's `.gitignore`. Writes: no.

## Structural tools

### `ast_grep`

Structural code search, ast-grep style — the pattern is translated to a
regex approximation of the metavariable grammar (see
[Pattern syntax](#pattern-syntax-ast_grep--ast_edit)). Returns up to 50
matches across up to 2000 files. When the pattern is a single exact
identifier the KB knows, a kb-first hint points at `kb_symbol`. Its `path`
parameter accepts a directory or a single file (default: current directory).
Writes: no.

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

**Proposal lifecycle**: proposals live in process memory only — lost on exit or
crash. The 10-minute TTL is measured from proposal creation, not sliding
`lastTouched`; `lastTouched` is used for LRU ordering only. `MAX_PROPOSALS` is 16, but
`stage()` prunes before insertion: immediately after staging a seventeenth
proposal, the process can temporarily retain 17 until a later prune removes
the LRU entry. A successful apply, discard, or read/tag/write failure consumes the proposal. A
permission-denied apply or an invalid action (checked before reading the
proposal) does not consume it. Expired, evicted, consumed, or process-exited
proposals cannot be recovered; run `ast_edit` again for a fresh proposal. In
error results, `rolledBack` counts files that entered the restoration attempt,
not confirmed restoration successes.

**Known limitation**: `ast_edit`'s directory expansion walks at most 2000
candidate files per root and does not report the truncation in its result —
a proposal over a very large tree may silently cover only the first 2000
walked files. Narrow `paths` when targeting big trees.

## Plan tools

### `plan`

Propose an execution plan when a complex task benefits from an explicit
strategy decomposition. With an interactive confirmation callback, the user
chooses strategies; without one, recommended strategies are auto-accepted.
The model-visible schema requires `summary` and `steps`. The prompt-recommended shape is a one-line summary plus 2–5 ordered
`steps`, each with a `goal` and 2–4 candidate `strategies`
({name, description, recommended}) with exactly one recommended. Runtime
normalization for direct/internal calls that bypass the schema treats a missing
or non-string `summary` as an empty string and enforces only a minimum of two
usable steps and two usable strategies per step, with no maximum; abnormal
recommended counts are normalized by selecting the first strategy. With a
confirmation callback the result is `{ confirmed:true, plan }`; without one
the result is `{ confirmed:true, plan:..., autoAccepted:true }`. Cancellation
returns `{ cancelled:true, ... }`, and an unusable shape returns `{ error }`.
Writes: no.

### `plan_step`

With an interactive progress callback, advance the live progress panel by
marking the CURRENT in-progress step of the confirmed plan as done — call once
after finishing each step. The `step` parameter is retained only as a
compatibility/reporting hint: the interactive state machine always advances
the current in-progress step, and the value never selects an arbitrary step.
Without a progress callback, `plan_step` merely acknowledges the report and
keeps no progress state or panel. Only interactive mode has a panel that can
clear after the last step; a normal turn end finalizes any leftover interactive
panel as a backstop. Do not call before `plan` returns a confirmed plan.
Writes: no.

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
| `kb_search` | Natural-language / keyword symbol search — BM25 + name-match reranking, with file paths, line ranges, snippets. Query is rewritten when an LLM is attached and `skip_rewrite` is not true; top-3 results carry a ±15-line source slice (`with_slice=false` to disable). `top_k`: falsy values including 0 default to a result budget of 10; other numeric values normalize to 5–50, while the actual result count may be lower when fewer matches exist |
| `kb_symbol` | Look up a symbol by exact identifier; all matching candidates |
| `kb_outline` | File outline from the loaded KB index — no source-content read, though permission/path metadata checks may occur; direct queries do not use `SOURCE_EXT_RE`; name / kind / lines / signature / parent / child count per symbol; a `tag` is returned when the indexed file has a hash |
| `kb_neighbors` | Legacy one-hop **outgoing** call-graph neighbors of a symbol (what it calls; no direction parameter — use `kb_callchain` with `direction=backward`/`both` for callers) |
| `kb_callchain` | Bounded BFS over the call graph — callers and/or callees up to `max_depth` hops. `max_nodes` applies independently to each selected direction; the BFS budget includes the starting node (omitted from the results), so for the recommended `max_nodes >= 2` each direction returns at most `max_nodes - 1` other nodes; `0`/`1`/negatives are not validated |
| `kb_class` | Class / interface / struct / enum lookup: `qual_name` exact, `name` substring with first-candidate match (prefer `qual_name` for ambiguous names); returns signature, doc string, members, super-classes, direct implementations |
| `kb_refs` | Reverse lookup of DIRECT (one-hop) relations: callers (depth 1), direct importers, directly derived classes (`kind=call\|import\|inherit\|any`) — not a transitive closure |
| `kb_implements` | Given an interface or base class, list its DIRECT implementers / direct subclasses recorded by the graph (one hop, not a transitive closure — query results again to walk deeper) |

## KB knowledge tools

| Tool | Purpose |
|---|---|
| `kb_knowledge` | Look up a knowledge entry by id — searches Holy and Eden, returns the full entry (title, intro, keyFiles, keySymbols, keywords, space) |
| `kb_search_knowledge` | Search both knowledge spaces by natural-language query; each whitespace token occurrence contributes at most one equal-weight point across one combined id/title/intro/keywords haystack, duplicate tokens can contribute again, ties preserve `allKnowledge()` order, and superseded Eden entries are not filtered. Falsy `top_k` values including 0 default to 5; other numeric values are bounded to 1–20 |
| `kb_save_knowledge` | Persist a knowledge entry to Holy (requires user approval) or Eden (auto-learn eligible); the KB runtime is hot-reloaded immediately. Caveat: an identical `kb_knowledge`/`kb_search_knowledge` call already cached earlier in the same `runLoop` may keep returning the stale cached result until a cache-busting call or a new loop. Saving via this tool marks the turn's knowledge capture as handled |

## Session tools

### `remember`

Persist a short, self-contained session fact (environment endpoints and
addresses, ports, versions, account or machine names, deployment constraints,
explicit preferences like "always run tests with X"). After successful
persistence, the fact is injected into subsequent turns via a standing
`## Session facts` system message placed right after the main system prompt and
survives context compaction by design; a missing callback or failed write
returns failure rather than recording it. Writes: session facts file only.

Boundaries (enforced by the tool guidelines the model receives):

- One fact per call, phrased self-contained ("staging endpoint 192.0.2.10",
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

> **Whitelist caveat / binary risk**: `ast_grep` and `ast_edit` filter files
> through the same `SOURCE_EXT_RE` heuristic whitelist, which also matches
> document formats (`.md`, `.json`, `.pdf`, `.docx`, …). They may therefore
> attempt to read such files as UTF-8 text; a directory-level `ast_edit`
> over a tree containing document/binary files can theoretically produce
> wrong matches and destructive rewrites. Scope directory rewrites to
> explicit text source sets. (Both tools are regex approximations, not
> full AST-boundary matching — see Deferred capabilities.)

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

The protection has one numbered flow:

1. `read` automatically adds a tag only when `outline !== false`, a KB runtime
   is loaded, the original path matches `SOURCE_EXT_RE`, and that raw path
   directly hits the KB file table. The tag is the first 8 hex characters of
   the file hash recorded in the KB registry; an outline additionally needs at
   least one symbol. `read` may miss absolute or differently-spelled paths.
2. Direct `kb_outline` does not use `SOURCE_EXT_RE`; any path present in the KB
   file table is queryable. It can return an empty outline and a valid tag when
   the indexed file has no symbols.
3. `edit` compares a supplied index-snapshot tag with a fresh hash of the
   current file. `ast_edit` applies one user-supplied tag to every target file,
   while its proposal separately stores each file's preview hash.
4. `resolve` re-validates each proposal hash file by file. A mismatch reports
   `stale tag: the current file hash differs from the supplied KB-index snapshot tag`.
   After `/kb update`, read or call `kb_outline` again to obtain a fresh tag.
   Omitting a tag skips this extra protection. A resolve failure attempts
   best-effort, non-transactional restoration; `rolledBack` counts files that
   entered the restoration attempt, not confirmed successes.

**Known limitation**: `ast_edit` uses regex approximation rather than AST-exact
matching; directory expansion walks at most 2000 candidate files per root and
currently does not report truncation. `SOURCE_EXT_RE` includes `.pdf` and
`.docx`, so wide `ast_grep`/`ast_edit` operations can try to process document
or binary content as UTF-8 text. Use explicit text-source paths or globs.

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
