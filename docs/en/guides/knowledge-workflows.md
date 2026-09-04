# Knowledge workflows

English | [简体中文](../../zh-CN/guides/knowledge-workflows.md)

This guide shows how to accomplish day-to-day KB tasks: build, update,
inspect, deep-study, import/export, curate, and clean up. It focuses on
*how to get things done* — the complete flag reference lives in
[Slash commands](../reference/slash-commands.md), and the underlying model in
[Knowledge base](../concepts/knowledge-base.md).

## Build and refresh the index

```bash
/kb init                                  # build (resumable; LLM summaries when a model is configured)
/kb init --skip-summary                   # skip the 3 LLM summary entries
/kb init --checkpoint-interval=50         # checkpoint every 50 files
/kb init --no-resume                      # ignore an existing checkpoint
/kb update                                # incremental (sha256 diff)
/kb status                                # per-space statistics
```

- `/kb init` **always performs a full re-index** in the current
  implementation — the `--full` flag is accepted but redundant; use
  `/kb update` for incremental refreshes. Interrupted builds resume from
  the checkpoint.
- `/kb update` incrementally re-parses changed source files, rebuilds the
  derived symbol/index/graph structures and `doc_index.json`, and synchronizes
  parser-owned `doc:<relpath>` Eden entries (new/changed docs written or replaced, deleted/excluded docs'
  parser-owned entries removed). It auto-detects a
  legacy KB: knowledge entries are backed up to `backup/pre-upgrade-<ts>/`
  first, then the migration is applied (a parser-version change triggers a
  full re-index).

**When to run what**: after `/project init` run `/kb init`; after normal
editing sessions run `/kb update` (or let `HK2_ENABLE_AUTOUPDATEKB=1` do it
when the agent fell back to bash searches); after branch switches or large
refactors run `/kb init` again — it is already a full rebuild.

### Checkpoint entry points

Interactive `/kb init` turns an unset, empty, `0`, or non-numeric environment
interval into 100; a positive integer is honored and a negative integer is
passed through, producing near-per-file saves. The explicit flag is parsed
directly, so `0`, negative, or `NaN` values likewise save almost every file.
An explicitly empty `--checkpoint-interval=` is falsey and falls back to the
environment/default wrapper rather than becoming `NaN`. `/kb update` and
automatic/legacy direct indexer paths do not receive the interactive `|| 100`
wrapper: environment `0`, negative, or invalid values reach `Checkpoint`
unchanged. Only `/kb init --no-checkpoint` is the documented disable switch.

## Query the KB

```text
/kb search password verification --top-k=5
/kb symbol login
/kb neighbors 80:78
/kb knowledge list
/kb knowledge list --space=eden
/kb knowledge show spi-extension-pattern
```

`/kb neighbors` takes a symbol id of the form `<fileId>:<line>` — grab one
from `/kb search` or `/kb symbol` output.

## Deep-study with `/kb knowledge learn`

The unified deep-study command auto-selects between two modes:

- **CODE mode** — no `--file`, or `--base-dir` pointing at an *indexed*
  subdirectory. Three-phase study of indexed source: an **optional** Phase 0
  writes three project-wide survey entries (`api-docs`, `code-walkthrough`,
  `usage-examples`) — it runs only when NOT `--dry-run`, NOT `--base-dir`,
  and NOT `--no-survey` (`--base-dir` scopes to the subdirectory and skips
  the whole-project survey; `--dry-run` and `--no-survey` skip it too);
  Phase 1 plans topic batches; Phase 2 performs one extraction call per batch
  and may produce zero or more proposed knowledge entries. Each proposal is
  validated independently and may be skipped, merged, conflict-resolved, or
  written.
- **DOC mode** — `--file=<path>` or a `--base-dir` that is not an indexed
  subdirectory. Deep-studies Markdown / PDF / Word / PowerPoint / text
  documents into the chosen space. Files may live outside the project; large
  files are split into sequential parts so extracted text is not silently
  truncated. Every study part that is successfully read, parsed, and
  non-empty is reconciled into some batch (planner omissions get single-file
  fallback batches) — but read failures, parse failures, empty text, and
  other errors can still skip content.

With the default `HK2_KB_LEARN_VALIDATE=1`, proposed entries are validated
against the existing KB before writing (duplicate → skipped, related →
merged in place, conflict → Holy defers to you, Eden follows the validator
with the reason printed); `HK2_KB_LEARN_VALIDATE=0` switches to the legacy
heuristic discard path instead.

```bash
# Study the whole project (CODE mode)
/kb knowledge learn

# Preview without writing
/kb knowledge learn --dry-run

# Scope to one indexed subdirectory, skip the survey
/kb knowledge learn --base-dir=src/retrieval --no-survey

# Study a document into Eden
/kb knowledge learn --space=eden --file=docs/spec.pdf

# Use a specific model for all learn LLM calls; steer with instructions
/kb knowledge learn --model=local/mymodel focus on error handling
```

Useful flags: `--dry-run`, `--no-survey`, `--base-dir=DIR`, `--file=PATH`,
`--space=eden|holy` (DOC mode default `eden`; CODE mode always writes Eden),
`--per-batch-chars=N` (LLM context budget per batch, default 100000),
`--model=<provider>/<model-id>`, `--plan-timeout-ms=N`, and free-form
trailing instructions passed to every LLM prompt.

### Large projects and fallbacks

Above **300 indexed files** the Phase 1 planner switches from file-level to
**directory-level planning** — the LLM groups directories (a much smaller
map), and each directory token is deterministically expanded into concrete
files, split into ≤30-file batches. If the LLM plan is still unusable
(reasoning models can spend their whole budget thinking), the command retries
once with reasoning disabled and finally falls back to deterministic
directory grouping — the study does not abort merely because the plan was
unparseable, and planner reconciliation adds fallback batches for readable,
parseable inputs the plan omitted. File access, parsing, model, permission,
disk errors, or a user interrupt can still stop the run or skip content.

**Slow providers**: the Phase 1 planning call has a default 300s budget; if
your provider exceeds it, pass `--plan-timeout-ms=600000` (or set
`HK2_PLAN_TIMEOUT_MS`).

## Manual entries, import/export

```bash
/kb knowledge add --title="SPI Pattern" --intro="Use PGXS; ..." --keywords=spi,extension
/kb knowledge add --space=eden --id=sql-cmds --title="SQL Commands" --intro-file=/tmp/sql.md
/kb knowledge export all /tmp/kb-dump.json
/kb knowledge import /tmp/kb-dump.json adaptive --overwrite
```

- `add` defaults to **holy**; `--intro-file` reads the body from a file;
  optional `--id`, `--key-files`, `--key-symbols`, `--keywords` annotate the
  entry for later retrieval.
- `export <eden|holy|all> <path>` writes a version-2 JSON file with per-entry
  `space` tags.
- `import <path> [eden|holy|adaptive] [--overwrite]` — `adaptive` routes each
  entry to its original space. Importing into **Holy always prompts y/N**.

## Curate: transform and housekeep

```bash
/kb transform sql-commands eden holy       # move an entry (confirm)
/kb knowledge housekeep all                # LLM-assisted cleanup
```

`housekeep` scans for broken entries, merges duplicate/similar ones (y/N),
and — with `all` — resolves Eden↔Holy conflicts through a per-pair choice
menu. The supreme-code entry is never touched; knowledge indexes are rebuilt
when anything changes. `--model=<provider>/<model-id>` picks the model.

## Supreme Code operations

```bash
/kb code list
/kb code add --code-content="API keys are strictly forbidden in any code file"
/kb code add 1 --code-content="..."       # update item 1 in place
/kb code add --code-gen="draft one rule about commit message format"
/kb code del 2
```

Limits and protection rules are covered in
[Knowledge base](../concepts/knowledge-base.md#project-supreme-code-hk2-supreme-code).

## Delete and reset

```bash
/kb knowledge del <id>          # one entry (confirm)
/kb knowledge empty eden        # every ordinary entry (Supreme Code preserved) — irreversible
/kb drop                        # delete the whole KB (confirm)
```

> **Warning**: `/kb knowledge empty` and `/kb drop` destroy data. Export
> first (`/kb knowledge export all <path>`) if you might want it back.

## Common recipes

- **New teammate onboarding** — `/kb init` → `/kb knowledge learn` → point
  them at `/kb knowledge show project-overview`.
- **Ingest a design doc** — `/kb knowledge learn --file=docs/design.md
  --space=eden`, then `/kb knowledge housekeep eden` to dedupe against
  existing entries.
- **After a big refactor** — `/kb init` (a full rebuild; graph shapes changed), then
  `/kb knowledge learn` to refresh the topic entries.
- **KB feels stale / duplicated** — `/kb update`, then
  `/kb knowledge housekeep all`.

## Related documentation

- [Knowledge base](../concepts/knowledge-base.md) — spaces, lifecycle, Supreme Code
- [Slash commands](../reference/slash-commands.md) — full `/kb` reference
- [Troubleshooting](troubleshooting.md) — timeouts, checkpoints, recovery
