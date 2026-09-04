# Environment variables

English | [简体中文](../../zh-CN/reference/environment-variables.md)

Complete list of hk2-specific environment variables, regenerated from a
code-wide `process.env` search — not copied from older docs. Defaults come
from the resolving code. When adding or changing a variable, re-run the
search and update this page in both languages. Standard terminal variables
hk2 honors are listed separately at the end.

Conventions: `HK2_ENABLE_*` feature flags go through `envFlag()` — `1`, `yes`, `true`, `on` (case-insensitive) enable; anything else, including `0`/`no`/`false`/`off`/unrecognized strings, disables. Separately, `HK2_NO_COLOR`, `HK2_ASCII`, and `NO_COLOR` use presence semantics: any non-empty value (even `0`) enables them; unset disables. Numeric resolvers vary — the
LLM timeout/retry/parallel variables treat unset / empty / invalid /
negative as "use the default" (explicit `0` meaning "no timeout" for the
timeouts, "one attempt" for retries), while threshold variables like
`HK2_AUTOCOMPACT_PCTUSED` clamp into their own ranges; each entry states
its own parsing rule.

## Paths and installation

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_HOME` | Config / data home | `~/.hk2` | Holds models.json, projects.json, sessions/, logs/; KBs live under `HK2_HOME/kb/` only when `HK2_KB_DIR` is unset |
| `HK2_KB_DIR` | KB root override | `$HK2_HOME/kb` | Caveat: legacy `--mode` commands detect the current project's KB via the default `$HK2_HOME/kb` path — with a custom `HK2_KB_DIR` that auto-detection can miss the real KB and fall back to `default`; set `HK2_KB_NAME` explicitly in that setup |
| `HK2_KB_NAME` | KB name for legacy `--mode` commands. Resolution: a non-empty `HK2_KB_NAME` wins; else the shared current project's UUID **when its KB dir already has `meta.json`**; else the literal `default` | non-empty value / project UUID / `default` | |
| `HK2_PREFIX` | Install prefix used by `install.sh` for the symlink | `/usr/local` | install.sh only |
| `HK2_INSTALL_DIR` | Self-contained source copy location used by `install.sh` | `~/.hk2` | install.sh only |
| `HK2_PROJECT_SOURCE` | Project source root for the tool sandbox | - | Set automatically in interactive mode |
| `HK2_PROJECT_ID` | Project id locating the per-project permission file | - | Set automatically in interactive mode; falls back to a `projects.json` source-path lookup |

## UI and display

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_UI` | Interactive front-end: `tui` or `repl` | `repl` | `--tui` / `--repl` flags take precedence |
| `HK2_TUI_STREAM` | Stream the TUI draws into: `stdout` flips the default | `stderr` | The TTY capability check follows this stream |
| `HK2_WELCOME` | TUI welcome card tier: `full` / `compact` / `auto` | `auto` | `auto`: full on first run; compact for returning users / screens < 30 rows. Full needs >= 88 cols; narrower terminals degrade |
| `HK2_REPL_HINTS` | `0` disables the REPL's live slash-completion hints | on | Restores the plain prompt |
| `HK2_HIDE_THINKING` | `1` (default): cap the `✎ thinking` window at 9 lines and collapse TUI thinking to `Thought for Ns`; `0`: render the full stream | `1` | |
| `HK2_NO_COLOR` | Disables ANSI colors when set to **any non-empty value** — `HK2_NO_COLOR=0` still disables them (the string "0" is non-empty); unset to re-enable. The standard `NO_COLOR` is honored with the same presence semantics | unset |
| `HK2_ASCII` | Forces ASCII fallbacks for box-drawing / spinner / icons when set to **any non-empty value** (`0` still enables them — the string "0" is non-empty; unset to disable) | unset | Useful on non-UTF-8 terminals |

## LLM requests, timeouts, retries

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_LLMAPI_TIMEOUT_MS` | Default timeout (ms) for every LLM API request (streaming and non-streaming) | `3600000` (3600s) | Precedence: per-call `opts.timeoutMs` > per-model `config.timeout` > this env. Explicit `0` = no timeout (no abort timer — plan/code review rely on this). Unset/invalid/negative fall back to the default |
| `HK2_LLMAPI_TIMEOUT_MS_SIMPLE` | Timeout (ms) for the lightweight single-shot phases: query rewrite and request-clarity assessment (turn-start passes and `kb_search`'s inline rewrite) | `300000` (300s) | Resolved via `llmApiTimeoutMsSimple()` in `lib/llm/timeout.js`; a per-call `opts.timeoutMs` still wins. Explicit `0` = no timeout. Previously hardcoded 15000ms |
| `HK2_LLMAPI_NUMOFRETRIES` | Max consecutive retries on transient LLM failures (network errors, HTTP 408/429/5xx, request timeouts); exponential backoff 1s → 30s cap; `{type:'retry'}` events between attempts. Deterministic 4xx and user aborts are NOT retried. Explicit `0` = one attempt | `10` | |
| `HK2_LLM_RETRY_UNKNOWN_POST` | UNKNOWN-outcome failures (mid-flight transport errors after the request was sent — reset, read/write-phase timeout — and HTTP 500/502/503/504, which a proxy can return after upstream already ran) are retried by default; set `0` to opt out (duplicate-request/billing concerns — providers expose no idempotency key). Connection-establishment failures (refused / DNS / connect-timeout, shown as `(CODE)` or `(CODE/connect)`) and HTTP 408/429 are outcome-safe and ALWAYS retried. Bounded by `HK2_LLMAPI_NUMOFRETRIES` | `1` | |

## Request pipeline (assessment, rewrite, fast lane)

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_ENABLE_QUERYREWRITE` | `1`: rewrite each substantive query via an LLM into English function names + keywords before BM25 retrieval (turn start; fast-lane follow-ups skip the whole pre-agent pipeline). The `kb_search` tool rewrites inline only when an LLM is available and `skip_rewrite=true` was not passed | `1` | Prerequisite for assess + fast lane |
| `HK2_ENABLE_REQUEST_ASSESS` | `1` (and query rewrite on): after the first query rewrite **and** KB retrieval, an LLM judges whether the request is clear — deliberately with the retrieved project context in hand; unclear requests get a numbered clarification menu whose answer feeds a second rewrite + retrieval pass. Judges against a session digest so follow-ups are not flagged; interactive TTY only; one bounded round; best-effort. Verdict fields recorded in the transcript's `assess` meta | `1` | |
| `HK2_ASSESS_MIN_CONFIDENCE` | Confidence threshold (0.0–1.0) below which an "unclear" verdict is treated as clear | `0.8` | A spurious menu costs more than an inline follow-up |
| `HK2_ASSESS_REASONING` | `1`: run the clarity assessment with deep reasoning (better pragmatic reference resolution on strong models; adds latency) | `0` | |
| `HK2_ENABLE_FOLLOWUP_FASTLANE` | `1` (and query rewrite on): certainly-conversational follow-ups (continuation cues, bare confirmations, a bare number picking the just-offered menu, plan-advance directives with an active plan) skip the entire pre-agent pipeline straight to the agent loop | `1` | Set `0` to restore the full pipeline for A/B comparison |
| `HK2_ENABLE_PHASEMODEL_FALLBACK` | Unreachable phase model (`rewrite-query`, `request-assess`): `1` warn + re-run the phase on the session model; `0` warn + skip. Review phases always skip (never substitute the reviewer). Fallback/skip recorded in the transcript | `1` | |

## Plan review and code review

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_ENABLE_PLANREVIEW` | `1`: after the user confirms a plan, an LLM reviews it (requirement checklist, per-point coverage, ordering, feasibility, risks) before execution; issues confirmed one-by-one; unparseable verdict = UNKNOWN. Interactive TTY only; best-effort | `0` | |
| `HK2_ENABLE_CODEREVIEW` | `1`: after a normal agent return when this turn confirmed a plan or started while continuing one, finalization may clear the panel and trigger a code review of the diff, changed files, and final summary; an ordinary mid-plan question can therefore also trigger it. Issues listed one-by-one; unparseable verdict = UNKNOWN. Interactive TTY only; best-effort | `0` | |

## KB build and learn

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_KB_CHECKPOINT_INTERVAL` | `/kb init` checkpoint cadence in files. `parseInt(value \|\| '100')` is passed directly to `Checkpoint.interval`: positive N saves every N marks; `0` and negative values save on almost every file; a non-numeric value becomes `NaN` and the comparison also causes frequent saves. Use `--no-checkpoint` to disable; do not rely on invalid values | `100` | Per-run `--checkpoint-interval=N` / `--no-checkpoint` |
| `HK2_INDEX_PARALLEL` | Parallelism of the KB parse pool. Only a strict positive integer string (`1`, `4`, `+8`) takes effect; unset, empty, `0`, negative, invalid, decimal (`1.5`), and scientific notation (`1e3`) use auto: `availableParallelism()`, then `cpus().length`, then 4 | `0` | |
| `HK2_PLAN_TIMEOUT_MS` | `/kb knowledge learn` Phase 1 planning timeout (ms). Parsed as `parseInt(value) \|\| 300000`: `0` and non-numeric values fall back to the default (this is NOT a "0 = disable" variable, unlike the LLM timeouts) | `300000` | Per-run `--plan-timeout-ms=N` |
| `HK2_ENABLE_AUTOUPDATEKB` | `1`: silently run an incremental `/kb update` at end of any turn where the agent fell back to bash to search source files. The update rebuilds the derived indexes AND synchronizes parser-owned `doc:<relpath>` Eden entries (see `/kb update`) | `0` | Otherwise prompts y/N |
| `HK2_ENABLE_AUTO_LEARN` | `1`: silently save the end-of-turn extracted knowledge entry to Eden. Holy ALWAYS prompts y/N regardless | `0` | |
| `HK2_KB_LEARN_COOLDOWN_MIN` | Positive minutes: skip the end-of-turn `[kb learn]` offer while a knowledge capture for this session's task was handled within the window (agent save, answered proposal, or model skip). Anchor restored across `--resume`. An agent `kb_save_knowledge` save this turn always skips the offer | `0` (off) | |
| `HK2_KB_LEARN_VALIDATE` | `1`: validate learned entries against existing KB before writing (pre-filter + one semantic check) — duplicates skipped, related entries merged, conflicts resolved (Holy defers to the user). Best-effort | `1` | |

## Compact

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_ENABLE_AUTOCOMPACT` | `1` (default): at the start of a turn, compact once measured context usage reaches the threshold. Keeps the last 4 user/assistant MESSAGES verbatim (not 4 full turns), LLM-summarizes earlier messages into one system message; the naive-truncation fallback concatenates the to-compact messages and truncates to a length-bounded system message without semantic summarization. Turn boundary only, never mid-turn. Facts saved explicitly (via `/remember` or the `remember` tool) survive compaction **by design**; the compaction-time extraction and the head+tail summarizer input that protect opening-stated facts are **best-effort** (the extraction is fail-open; the naive-truncation fallback summarizes nothing) | `1` | |
| `HK2_AUTOCOMPACT_PCTUSED` | Context-usage trigger percentage (1–100) | `90` | |

## First-run import

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_AUTOIMPORT_CLAUDE` | `0` disables the first-run model import from Claude Code's `~/.claude/settings.json` (TUI only) | on | Fill-only; never overwrites an existing default |

## Debugging and compatibility

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `HK2_DEBUG` | Print error stacks (fatal errors, slash-command errors) | - | |

## Provider API keys

| Variable | Purpose | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Process-env key: seeds an `anthropic` provider when the model registry file is first created (not re-scanned on later starts) | - | The Claude Code import reads same-named keys from `~/.claude/settings.json` — a separate source (see below) |
| `OPENAI_API_KEY` | Process-env key: seeds an `openai` provider when the model registry file is first created | - | |

## Standard terminal environment variables honored

These are not hk2-specific; hk2 reads them the way terminal tools usually do:

| Variable | Used for |
|---|---|
| `NO_COLOR` | Disables ANSI colors (same effect as `HK2_NO_COLOR=1`) |
| `TERM` | Color-mode and TUI capability detection: `dumb` disables color and blocks the TUI; `linux` or empty selects ANSI 256-color; other TERM values, including `xterm-256color`, fall through to truecolor. `xterm-256color` is also an independent Windows UTF-8 inference signal |
| `COLORTERM` | Truecolor detection (`truecolor` / `24bit` → 24-bit color mode) |
| `WT_SESSION` | Windows Terminal detection: truecolor inference + Windows UTF-8 capability inference |
| `TERM_PROGRAM` | `vscode` feeds the Windows UTF-8 capability inference (not truecolor detection) |
| `LC_ALL` / `LC_CTYPE` / `LANG` | UTF-8 locale detection (glyph vs ASCII fallback rendering) |

## Claude Code settings env keys consumed during first-run import

The TUI first-run import reads these from the `env` object of
`~/.claude/settings.json` — NOT from the hk2 process environment:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_MODEL`

A process-level `ANTHROPIC_API_KEY` seeds the registry through a different
path (first registry creation); the settings-file key only feeds the import.

## Related documentation

- [Agent workflow](../concepts/agent-workflow.md) — where the pipeline flags apply
- [Configuration](configuration.md) — the files these variables point around
- [Troubleshooting](../guides/troubleshooting.md) — timeout and retry diagnostics
