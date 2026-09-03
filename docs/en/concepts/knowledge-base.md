# Knowledge base

English | [简体中文](../../zh-CN/concepts/knowledge-base.md)

This page explains hk2's per-project knowledge base: the three-space model
(Holy / Eden / Index), what lives in each space, how entries are updated, and
Project Supreme Code — the protected entry that outranks everything else.

Every registered project gets its own KB, isolated by project UUID under
`~/.hk2/kb/<projectId>/`. Nothing is shared between projects; dropping a
project preserves its KB until you delete it explicitly.

## The three-space model

| Space | Contents | Update policy |
|---|---|---|
| **Holy** | Stable design knowledge (architecture, algorithms, key patterns). Manually authored or imported from authoritative sources. | **Always requires explicit user approval**, even when `HK2_ENABLE_AUTOUPDATEKB=1` or `HK2_ENABLE_AUTO_LEARN=1`. |
| **Eden** | Frequently-updated knowledge (function catalogs, command lists, observed patterns, module summaries, **parsed docs**, **auto-generated summaries**). | Auto-updatable when `HK2_ENABLE_AUTO_LEARN=1`; otherwise prompts y/N. |
| **Index** | Code index (BM25 over symbols), knowledge graph (call chains / class hierarchy / imports / inheritance), and per-space indexes over Holy/Eden entries. | Auto-updatable when `HK2_ENABLE_AUTOUPDATEKB=1`; otherwise prompts y/N. |

The split is about **trust and churn**, not storage: Holy holds things that
should only change when a human says so; Eden holds things that legitimately
change often; Index is derived data that can always be rebuilt from source.

## What each space stores

- **Holy Space** — design principles, architecture decisions, project laws,
  and the Supreme Code entry. Written via `/kb knowledge add --space=holy`,
  `/kb knowledge import`, or by promoting an Eden entry with `/kb transform`.
- **Eden Space** — LLM-authored summaries (`/kb init`, `/kb knowledge learn`),
  automatically captured end-of-turn knowledge (`[kb learn]`), parsed
  documents (`doc:<relpath>` entries), and manually added fast-moving facts.
- **Index Space** — BM25 inverted index, sharded symbol table, file registry,
  the code knowledge graph, and per-space keyword indexes over Holy/Eden.
  Purely derived; `/kb update` refreshes it incrementally, `/kb init --full`
  rebuilds it.

## Entry lifecycle

1. **Creation** — an entry enters Holy or Eden through: manual
   `/kb knowledge add`, deep-study (`/kb knowledge learn`), import
   (`/kb knowledge import`), the end-of-turn `[kb learn]` capture, or
   `/kb init`'s auto-generated summaries.
2. **Use** — the agent retrieves entries via `kb_knowledge` / `kb_search_knowledge`,
   and related entries are injected as per-request context.
3. **Validation on write** — every learned entry is checked against existing
   entries before writing (duplicates skipped, related entries merged in
   place, conflicts resolved — Holy conflicts always defer to the user).
   Disable with `HK2_KB_LEARN_VALIDATE=0`.
4. **Curation** — `/kb knowledge housekeep` merges duplicates and resolves
   Eden↔Holy conflicts; `/kb transform` moves an entry between spaces
   (confirmation required).
5. **Deletion** — `/kb knowledge del <id>` removes one entry (confirmation);
   `/kb knowledge empty <scope>` removes *all* entries in a space
   (irreversible, always confirms).

## Project Supreme Code (`hk2-supreme-code`)

Every project's Holy Space carries one **permanent, protected entry** —
`hk2-supreme-code` — holding the project's *fundamental laws*: short,
imperative rules that EVERY hk2 operation (reading, writing, editing,
planning, answering) must obey and can never violate. It is created **empty**
by `/kb init` (legacy projects get an empty shell auto-created), so nothing is
enforced until you write laws into it.

- **Design purpose**: a single, always-visible place for the project owner to
  encode non-negotiable constraints — security policies, coding standards,
  compliance requirements — that outrank the agent's general preferences and
  every other KB entry.
- **Injection**: on each request the items are rendered into the system prompt
  as a `# Project Supreme Code (MUST OBEY — never violate)` section placed
  *before* the KB knowledge-graph context. If an operation would violate any
  item, the agent must refuse it, cite the item's number, and propose a
  compliant alternative.
- **Protection**: the entry itself can never be deleted, renamed, moved,
  emptied, imported over, or auto-updated — enforced at both the command layer
  and the storage layer.

Usage (the only way to modify it; every write requires an explicit y/N
confirmation):

```
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
LLM-authored Eden entries. None require manual writing — both commands
overwrite prior versions on each run.

**`/kb init`** writes 3 high-level structural entries (skipped with
`--skip-summary`):

| Entry id | Contents |
|---|---|
| `project-overview` | 600–900-word prose summary: what the project does, high-level architecture, key modules, notable patterns. |
| `architecture-diagram` | A Mermaid flowchart of module / layer relationships with a short legend. |
| `architecture-decisions` | 4–8 ADR-style entries inferred from detected technologies, each with concrete modification suggestions. |

**`/kb knowledge learn`** in CODE mode writes survey + topic entries (see
[Knowledge workflows](../guides/knowledge-workflows.md) for the full mode
matrix):

| Entry id | Phase | Contents |
|---|---|---|
| `api-docs` | 0 | Numbered reference for the most important public / exported symbols across the whole project. |
| `code-walkthrough` | 0 | 4–8 sections walking through the most central core abstractions. |
| `usage-examples` | 0 | 3–5 numbered quickstart examples using real public symbols. |
| `<topic-id>` (dynamic) | 2 | One entry per LLM-planned topic, each focused on a coherent subsystem (e.g. `buffer-pool`, `transaction-mgmt`, `wal-replay`). |

Retrieve any of them via `kb_knowledge("<id>")` or
`kb_search_knowledge("overview")`.

## Auto-learn and auto-update boundaries

Two env flags control what the agent may write to the KB without asking:

- `HK2_ENABLE_AUTO_LEARN=1` — end-of-turn knowledge capture writes to Eden
  silently. **Holy always prompts y/N**, regardless of this flag.
- `HK2_ENABLE_AUTOUPDATEKB=1` — a silent incremental `/kb update` (Index
  Space) runs at the end of any turn where the agent fell back to `bash` to
  search source files. This only refreshes derived index data, never Holy or
  Eden entries.

Both default to `0` (off). See
[Environment variables](../reference/environment-variables.md).

## Related documentation

- [Knowledge graph and retrieval](knowledge-graph-and-retrieval.md) — what Index Space contains and how it is queried
- [Knowledge workflows](../guides/knowledge-workflows.md) — the commands that build and curate a KB
- [Configuration](../reference/configuration.md) — the on-disk KB layout
