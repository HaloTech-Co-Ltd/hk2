# Knowledge base

English | [简体中文](../../zh-CN/concepts/knowledge-base.md)

This page explains hk2's per-project knowledge base: the three-space model
(Holy / Eden / Index), what lives in each space, how entries are updated, and
Project Supreme Code — the protected entry that outranks everything else.

A project registered with `/project init` gets its own KB once `/kb init`
runs, isolated by project UUID under `$HK2_KB_DIR/<projectId>/` (default
`$HK2_HOME/kb/<projectId>/`; `HK2_KB_DIR` can relocate the root). Nothing is
shared between projects; dropping a project preserves its KB directory until
you delete it explicitly.

## The three-space model

| Space | Contents | Current update behavior |
|---|---|---|
| **Holy** | Stable design knowledge (architecture, algorithms, key patterns). Manually authored or imported from authoritative sources. | Agent-proposed and automatic writes require approval (even with the auto flags set); explicit user commands carry their own semantics (see the write-path table below). |
| **Eden** | Frequently-updated knowledge (function catalogs, command lists, observed patterns, module summaries, **parsed docs**, **auto-generated summaries**). | Agent knowledge capture follows `HK2_ENABLE_AUTO_LEARN`; parser-owned `doc:<relpath>` entries are additionally synchronized by `/kb init` and `/kb update` (see below). |
| **Index** | Code index (BM25 over symbols), knowledge graph (call chains / class hierarchy / imports / inheritance), and per-space indexes over Holy/Eden entries. | Explicit `/kb init` / `/kb update` run immediately; the end-of-turn automatic update is gated on `HK2_ENABLE_AUTOUPDATEKB`. |

The split is about **trust and churn**, not storage: Holy holds things that
should only change when a human says so; Eden holds things that legitimately
change often; Index is derived data that can always be rebuilt from source.

Confirmation behavior depends on the **write path**, not just the space:

| Path | Current confirmation behavior |
|---|---|
| `/kb knowledge add --space=holy` | Explicit user command — writes directly, no extra generic y/N |
| `/kb init` / `/kb update` | Explicit commands — do not go through the auto-learn/auto-update confirmation flow |
| `kb_save_knowledge` → Holy | Always requires interactive confirmation; refused when no confirm callback exists |
| `kb_save_knowledge` → Eden | Auto-writes with `HK2_ENABLE_AUTO_LEARN=1`, otherwise confirms |
| End-of-turn knowledge proposal | Only arises when the end-of-turn flow triggers; confirms per target-space policy |
| `/kb knowledge learn --space=holy` (DOC mode) | Prompts once per run before extraction; merges into / overwrites of existing Holy entries confirm per entry, while new entries after the gate write directly |
| `/kb transform`, import → Holy, `del` / `empty` / `/kb drop` | Each keeps its own destructive/confirmation prompt |

## What each space stores

- **Holy Space** — design principles, architecture decisions, project laws,
  and the Supreme Code entry. Written via `/kb knowledge add --space=holy`,
  `/kb knowledge import`, or by promoting an Eden entry with `/kb transform`.
- **Eden Space** — LLM-authored summaries (`/kb init`, `/kb knowledge learn`),
  automatically captured end-of-turn knowledge (`[kb learn]`), parsed
  documents (`doc:<relpath>` entries), and manually added fast-moving facts.
- **Index Space** — BM25 inverted index, sharded symbol table, file registry,
  the code knowledge graph, and per-space keyword indexes over Holy/Eden.
  Purely derived; `/kb update` refreshes it incrementally, `/kb init`
  (always a full build) rebuilds it.

## Entry lifecycle

1. **Creation** — an entry enters Holy or Eden through: manual
   `/kb knowledge add`, deep-study (`/kb knowledge learn`), import
   (`/kb knowledge import`), the end-of-turn `[kb learn]` capture, or
   `/kb init`'s auto-generated summaries. Direct user commands like
   `/kb knowledge add --space=holy` are themselves the explicit intent and
   write immediately; confirmation prompts apply to the *agent-proposed*
   paths (`kb_save_knowledge`, `[kb learn]`, imports into Holy, housekeep
   merges, conflicts).
2. **Use** — the agent retrieves entries via `kb_knowledge` / `kb_search_knowledge`,
   and related entries are injected as per-request context.
3. **Validation on write** — entries proposed by *learning* paths are
   validated against existing entries by default
   (`HK2_KB_LEARN_VALIDATE=1`): duplicates are skipped, related entries
   merged in place, conflicts resolved — Holy conflicts always defer to the
   user. With `HK2_KB_LEARN_VALIDATE=0` the legacy heuristic discard path
   runs instead; validation failures fall through as plain new entries.
4. **Curation** — `/kb knowledge housekeep` merges duplicates and resolves
   Eden↔Holy conflicts; `/kb transform` moves an entry between spaces
   (confirmation required).
5. **Deletion** — `/kb knowledge del <id>` removes one entry (confirmation);
   `/kb knowledge empty <scope>` removes every *ordinary* entry in a space
   while preserving the permanent Supreme Code entry (irreversible, always
   confirms). `/kb drop` deletes the whole project KB.

## Project Supreme Code (`hk2-supreme-code`)

Every project's Holy Space carries one **permanent, protected entry** —
`hk2-supreme-code` — holding the project's *fundamental laws*: short,
imperative rules that every hk2 operation (reading, writing, editing,
planning, answering) is instructed to obey at top priority (model-level
compliance; see the injection note below). It is created **empty** by
`/kb init` (legacy projects get an empty shell auto-created), so nothing is
injected until you write laws into it.

- **Design purpose**: a single, always-visible place for the project owner to
  encode non-negotiable constraints — security policies, coding standards,
  compliance requirements — that outrank the agent's general preferences and
  every other KB entry.
- **Injection (model-level)**: when the entry has at least one item, each
  request renders them into the system prompt as a
  `# Project Supreme Code (MUST OBEY — never violate)` section placed
  *before* the KB knowledge-graph context, instructing the agent to refuse
  violating operations, cite the item's number, and propose a compliant
  alternative. Compliance is a high-priority model instruction, not a
  formally verified execution guarantee. An empty entry injects nothing.
- **Protection (hard limits)**: the entry itself cannot be deleted, renamed,
  moved, emptied, imported over, or auto-updated — enforced at both the
  command layer and the storage layer.

Usage (the only way to modify it; every write requires an explicit y/N
confirmation):

```text
/kb code list                                # show all items
/kb code add --code-content="API keys are strictly forbidden in any code file"
/kb code add 1 --code-content="..."          # update item 1 in place
/kb code add --code-gen="draft one rule about commit message format"
/kb code del 2                               # delete item 2; later items shift up
```

Limits: max **100 items**, **200 characters** each, numbered 1..N with no
gaps (`/kb code add` without an id appends as item N+1; an id > N+1 is
rejected). Keep items short and imperative — genuinely complex rules belong
in their own Holy entry, referenced from a code item as `**KB(entry-id)**`.
`/kb status` shows the current count.

## Auto-generated Eden entries

`/kb init` and `/kb knowledge learn` produce complementary sets of
LLM-authored Eden entries — no manual writing required.

**`/kb init`** attempts 3 fixed-id structural entries **when a model is
configured and `--skip-summary` is not passed** (without an LLM the index is
still built and the summaries are skipped). Each summary is its own LLM
call: an entry is written only when its call returns non-empty content, a
successful write overwrites the previous version of that fixed id, and one
summary failing does not imply the others fail:

| Entry id | Contents |
|---|---|
| `project-overview` | 600–900-word prose summary: what the project does, high-level architecture, key modules, notable patterns. |
| `architecture-diagram` | A Mermaid flowchart of module / layer relationships with a short legend. |
| `architecture-decisions` | 4–8 ADR-style entries inferred from detected technologies, each with concrete modification suggestions. |

**`/kb knowledge learn`** in CODE mode writes an optional Phase-0 survey
(fixed ids below — generated only when not `--dry-run`, no `--base-dir`,
and no `--no-survey`) plus validated dynamic topic entries (see
[Knowledge workflows](../guides/knowledge-workflows.md) for the full mode
matrix):

| Entry id | Phase | Contents |
|---|---|---|
| `api-docs` | 0 | Numbered reference for the most important public / exported symbols across the whole project. |
| `code-walkthrough` | 0 | 4–8 sections walking through the most central core abstractions. |
| `usage-examples` | 0 | 3–5 numbered quickstart examples using real public symbols. |
| `<topic-id>` (dynamic) | 2 | One extraction call per planned batch may produce zero or more proposed entries; each is validated independently. |

Retrieve any of them via `kb_knowledge("<id>")` or
`kb_search_knowledge("overview")`.

## Parser-owned `doc:*` entries

`doc:<relpath>` is the indexer's managed Eden entry id for a parsed document.
The on-disk filename is sanitized for safe storage, but the entry id retains
the `doc:` prefix. `/kb init` and `/kb update` can replace the parser-owned
entry for the same document, and deleting or excluding a document can remove
that entry. Do not hand-create `doc:*` ids: a same-id manual entry may be
overwritten by later indexing. Use another id for hand-authored document
knowledge.

## Auto-learn and auto-update boundaries

Two env flags control what the agent may write to the KB without asking:

- `HK2_ENABLE_AUTO_LEARN=1` — end-of-turn knowledge capture writes to Eden
  silently. **Holy always prompts y/N**, regardless of this flag (this
  confirmation applies to agent-proposed captures; direct commands like
  `/kb knowledge add --space=holy` are your own explicit intent).
- `HK2_ENABLE_AUTOUPDATEKB=1` — a silent incremental `/kb update` runs at
  the end of any turn where the agent fell back to `bash` to search source
  files. It refreshes the derived symbol indexes/graphs and also
  synchronizes parser-owned `doc:<relpath>` Eden entries for indexed
  documents (writes/replaces entries for new or changed docs, removes
  parser-owned entries of deleted/excluded docs); it does not touch
  hand-authored Holy or ordinary Eden entries.

Both default to `0` (off). See
[Environment variables](../reference/environment-variables.md).

## Related documentation

- [Knowledge graph and retrieval](knowledge-graph-and-retrieval.md) — what Index Space contains and how it is queried
- [Knowledge workflows](../guides/knowledge-workflows.md) — the commands that build and curate a KB
- [Configuration](../reference/configuration.md) — the on-disk KB layout

### Status self-healing

`/kb status` normally reads and reports statistics. For a legacy KB missing the
permanent `hk2-supreme-code` entry, it attempts a best-effort creation of an
empty permanent entry first; a failure is ignored and not separately reported.
This exceptional compatibility path may write to disk. Initial `KBRuntime`
loading has the same missing-entry self-heal attempt.
