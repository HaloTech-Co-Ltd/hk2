# Knowledge workflows

English | [简体中文](../../zh-CN/guides/knowledge-workflows.md)

This guide shows how to accomplish day-to-day KB tasks: build, update,
inspect, deep-study, import/export, curate, and clean up. It focuses on
*how to get things done* — the complete flag reference lives in
[Slash commands](../reference/slash-commands.md), and the underlying model in
[Knowledge base](../concepts/knowledge-base.md).

## Build and refresh the index

```bash
/kb init                                  # build (resumable, auto-summaries)
/kb init --skip-summary                   # skip the 3 LLM summary entries
/kb init --checkpoint-interval=50         # checkpoint every 50 files
/kb init --no-resume                      # ignore an existing checkpoint
/kb update                                # incremental (sha256 diff)
/kb status                                # per-space statistics
```

- `/kb init` performs a **full re-index by default** (`--full` is
  effectively the default; `--full=false` is the opt-out); interrupted
  builds resume from the checkpoint.
- `/kb update` re-parses only changed files (Index Space). It auto-detects a
  legacy KB and upgrades it losslessly — knowledge is snapshotted to
  `backup/pre-upgrade-<ts>/` first; a parser-version change triggers a full
  re-index.

**When to run what**: after `/project init` run `/kb init`; after normal
editing sessions run `/kb update` (or let `HK2_ENABLE_AUTOUPDATEKB=1` do it
when the agent fell back to bash searches); after branch switches or large
refactors run `/kb init` again — it is already a full rebuild.

## Query the KB

```
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
  subdirectory. Two-phase study of indexed source: Phase 0 writes three
  project-wide survey entries (`api-docs`, `code-walkthrough`,
  `usage-examples`; skipped with `--no-survey`), Phase 1 plans topic batches,
  Phase 2 extracts one entry per topic.
- **DOC mode** — `--file=<path>` or a `--base-dir` that is not an indexed
  subdirectory. Deep-studies Markdown / PDF / Word / PowerPoint / text
  documents into the chosen space. Files may live outside the project; large
  files are split into sequential parts so nothing is silently truncated, and
  every document is guaranteed a batch (planner omissions get single-file
  fallback batches).

Every run validates proposed entries against the existing KB before writing
(duplicate → skipped, related → merged in place, conflict → Holy defers to
you, Eden follows the validator with the reason printed).

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
directory grouping — the study never aborts *because of an unusable LLM
plan* and always keeps full file coverage. Other failures (file access,
the model connection, disk writes, user interrupts) can still stop the run.

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
/kb knowledge empty eden        # ALL entries in a space — irreversible, always confirms
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
