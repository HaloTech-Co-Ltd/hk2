# Troubleshooting

English | [简体中文](../../zh-CN/guides/troubleshooting.md)

Symptom-driven fixes for the most common hk2 problems. Each entry gives the
symptom, the cause, the fix, and where to read more. Error strings quoted
here come from the shipped code.

## Installation and parsing

### `/kb init` logs `tree-sitter parse failed`

- **Cause**: the Tree-sitter native bindings are missing or ABI-mismatched —
  typically a very new Node version (e.g. Node 25+) against prebuilt
  binaries, or a skipped `npm install`.
- **Fix**: hk2 already fell back to its regex parsers (lower symbol
  coverage, same behavior otherwise). For full precision: use Node 20 LTS,
  or recompile the bindings from source with `npm rebuild` inside the
  install dir (default `~/.hk2`).
- **See**: [Installation](../getting-started/installation.md),
  [CLI and language support](../reference/cli-and-language-support.md).

### Installer printed "Warning: npm install failed"

- **Cause**: `npm install --omit=optional` failed midway (network,
  toolchain) — the install itself completed and hk2 runs on regex parsers.
- **Fix**: `cd ~/.hk2 && npm install` once the underlying issue is resolved.
  Passing `--no-npm-install` to `install.sh` skips the step on purpose.

### `AST dispatcher: tree-sitter not available` warning at startup

- **Cause**: the `tree-sitter` package is not loadable at all (not
  installed, or `--no-npm-install` was used).
- **Fix**: run `npm install` in the install dir. The warning is informational;
  everything works with reduced symbol precision.

## Models and providers

### "No model configured" / REPL refuses to chat about models

- **Cause**: `models.json` has no default model.
- **Fix**: `/model add <provider> <id> ...` then
  `/model set-default <provider>/<id>`; or export `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` before first run to auto-create a provider; or run
  `hk2 --tui` once to import from Claude Code's config.
- **See**: [Models, projects, and sessions](models-projects-and-sessions.md).

### Provider errors "model code does not exist"

- **Cause**: the wire `name` carries decoration (e.g. `mymodel[1m]`) the
  gateway rejects.
- **Fix**: keep the context-window hint on the `id`, set `name` to the exact
  wire code via `/model set <ref> --name=<code>`.
- **See**: [Models, projects, and sessions](models-projects-and-sessions.md#id-vs-name).

### LLM calls time out or the provider is slow

- **Cause**: default timeouts are generous (3600s general, 300s for
  rewrite/assess), but slow reasoning models can still exceed the
  `/kb knowledge learn` planning budget (300s).
- **Fix**: `--plan-timeout-ms=600000` on the learn command, or set
  `HK2_PLAN_TIMEOUT_MS`; adjust `HK2_LLMAPI_TIMEOUT_MS` /
  `HK2_LLMAPI_TIMEOUT_MS_SIMPLE` globally. Explicit `0` disables the timer.
- **See**: [Environment variables](../reference/environment-variables.md).

### Transient failures retry — did my request run twice?

- **Symptom**: a request fails with HTTP 500/502/503/504 or a mid-flight
  transport error, then retries.
- **Cause**: outcomes that *may* have executed (HTTP 5xx after the request
  was sent) are retried by default (`HK2_LLM_RETRY_UNKNOWN_POST=1`) — for
  interactive use a dead turn is worse than a rare duplicate request.
  Providers expose no idempotency key. Connection-establishment failures and
  HTTP 408/429 are outcome-safe and always retried.
- **Fix (if you care about duplicate billing)**: set
  `HK2_LLM_RETRY_UNKNOWN_POST=0`. Retry counts are bounded by
  `HK2_LLMAPI_NUMOFRETRIES` (default 10).
- **See**: [Environment variables](../reference/environment-variables.md).

### A phase model is unreachable

- **Symptom**: warning printed; `rewrite-query` / `request-assess` either
  re-ran on the session model or was skipped.
- **Cause**: `HK2_ENABLE_PHASEMODEL_FALLBACK` (default 1) reruns those
  phases on the session model; `0` skips them. Review phases
  (`plan-review`, `code-review`) always skip on an unreachable model — never
  silently substituting the reviewer.
- **Fix**: check the phase ref with `/model list`, or clear the override
  with `/model set-phase --phase=<name> --clear`. Every fallback/skip is
  recorded in the session transcript for auditing.

## Projects and KB

### "KB not built for project <name>. Run /kb init before chatting."

- **Cause**: hk2 is KB-driven; chat requires an initialized KB.
- **Fix**: run `/kb init`. If the project itself is not registered yet:
  `/project init --name=... --source=...` first.
- **See**: [Quick start](../getting-started/quick-start.md).

### `/kb update` triggers a full re-index

- **Cause**: the stored parser version changed between hk2 versions — a full
  re-index is required for correctness. Legacy layouts are upgraded
  losslessly (knowledge snapshot goes to `backup/pre-upgrade-<ts>/` first).
- **Fix**: none needed; let it run.

### `/kb knowledge learn` planning seems stuck, then fails

- **Cause**: the Phase 1 planning LLM call exceeded the 300s budget, or the
  plan came back unusable.
- **Fix**: hk2 already retries once with reasoning disabled and then falls
  back to deterministic directory grouping (full file coverage, never
  aborts). For slow providers raise the budget:
  `--plan-timeout-ms=600000` or `HK2_PLAN_TIMEOUT_MS`.
- **See**: [Knowledge workflows](knowledge-workflows.md).

### An interrupted `/kb init` — do I lose progress?

- **You do not start from zero.** A checkpoint is saved every N files
  (default 100); re-running `/kb init` resumes from the *most recent
  checkpoint*. Files processed after that checkpoint but before the next one
  are re-processed on resume, and an interruption before the first
  checkpoint has nothing saved yet. Use `--no-resume` to start over and
  `--no-checkpoint` to disable checkpointing.

## Front-ends

### TUI falls back to the REPL with a notice

- **Message**: `[tui] this terminal does not support the TUI (needs a TTY
  stdin/output and TERM != dumb) — using the line REPL.`
- **Cause**: piped stdin/stdout, `TERM=dumb`, or a CI console. Capability is
  judged against the stream the TUI draws into (stderr unless
  `HK2_TUI_STREAM=stdout`).
- **Fix**: run in a real terminal, or keep the REPL — both share the same
  session, commands, and pipeline.
- **See**: [REPL and TUI](repl-and-tui.md).

### Session resume does not restore my interrupted plan

- **Cause**: state is only restored when the saved plan has unfinished
  steps; completed plans clear the state.
- **Fix**: resume with `hk2 --resume`, then type a continuation cue
  (`continue`) — the saved task context is injected so the agent continues
  instead of restarting.
- **See**: [Agent workflow](../concepts/agent-workflow.md#interruption-and-recovery).

## Permissions

### `permission denied: <path>: denied by setting.json <layer> rule at <rule path>`

- **Cause**: the path is outside the project roots and no `allow` rule
  covers it, or a `deny` rule matches with a longer prefix.
- **Fix**: add an `allow` rule to `~/.hk2/setting.json` (global) or
  `~/.hk2/settings/<project-id>/setting.json` (per project). Remember:
  longest prefix wins; equal prefixes — project layer beats global, `deny`
  beats `allow`.
- **See**: [Security and permissions](security-and-permissions.md).

### A symlink inside the project is denied

- **Cause**: it resolves to a location outside the project; the real path is
  re-checked with the same rules.
- **Fix**: add an `allow` rule for the *real* target path (either spelling
  matches).

### Config rules are ignored with a load-time warning

- **Cause**: invalid entry — bad mode char (e.g. `"allow": "q"`), missing
  `allow`/`deny`, or both fields present. Only the offending entry is
  dropped; the rest keep working.
- **Fix**: correct the named entry. A `setting.json` inside the project root
  is ignored by design — move it to
  `~/.hk2/settings/<project-id>/setting.json`.

## Debugging

- `HK2_DEBUG=1` — print error stacks (also stacks under `/command` errors).
- `HK2_ASCII=1` — force ASCII fallbacks on non-UTF-8 terminals.
- `HK2_NO_COLOR=1` (or `NO_COLOR`) — disable ANSI colors.
- Logs live under `~/.hk2/logs/`; session transcripts (per-turn metadata
  like `assess`, `rewrite`, `graph`, `codeReview`) under
  `~/.hk2/sessions/<projectId>/`.

## Related documentation

- [Installation](../getting-started/installation.md)
- [Security and permissions](security-and-permissions.md)
- [Environment variables](../reference/environment-variables.md)
