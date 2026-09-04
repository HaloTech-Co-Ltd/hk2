# Planning and review

English | [简体中文](../../zh-CN/guides/planning-and-review.md)

This guide explains hk2's planning and review machinery: when the agent
creates a plan, how you confirm it, the live progress panel, optional plan
review and code review, and what happens when a reviewer cannot produce a
verdict. The gating environment variables all default to **off**.

## Plans

The agent decides when to plan — there is no pre-execution plan pass. When
the model judges a task complex enough to warrant a strategy decision
(multiple distinct phases, a design choice the user should confirm, or
several affected subsystems), it calls the `plan` tool:

- a one-line summary, plus
- an intended shape of 2–5 ordered steps, each with 2–4 candidate
  strategies (one marked recommended) — the recommended shape the prompt
  asks for; runtime validation enforces only a minimum of two usable steps
  and two usable strategies per step, with no maximum.

Simple tasks skip `plan` entirely and execute directly.

### Confirmation

The plan surfaces as a menu: you pick a strategy per step (or accept the
recommended one). The finalized plan is returned to the agent, which
executes step by step. Cancelling the menu cancels the plan — the agent sees
a `cancelled` result and adapts. In non-interactive mode the recommended
strategy is auto-accepted.

### The progress panel

Once a plan is confirmed, a live panel is pinned above the status bar:

```text
▣ Plan: sync README docs with code
  ✓ 1. Add missing plan_step tool
  ▶ 2. Document the progress panel
    3. Fix tree-sitter package count
    4. Commit and push
```

After finishing each confirmed step the agent calls `plan_step` once; each
call marks the CURRENT in-progress step done and advances the panel — the
`step` argument is accepted but deliberately ignored for the mutation, so
invalid, out-of-range, or out-of-order values never jump steps. When the
last step completes the panel clears automatically, and when the turn ends
normally a finalization pass clears any panel left un-advanced (a backstop).
Tasks that never called `plan` never show a panel.

The panel survives interruption: interrupted-task state (original request,
summary, plan progress) is persisted, and `hk2 --resume` restores it (see
[Agent workflow](../concepts/agent-workflow.md#interruption-and-recovery)).

## Plan review

With `HK2_ENABLE_PLANREVIEW=1` (default off), after you confirm a plan an
LLM re-reviews the finalized plan before execution begins. The reviewer:

1. re-analyzes the requirement as a numbered checklist;
2. checks per-point coverage (which step covers each requirement —
   complete / partial / missing), ordering and contradictions, feasibility
   of each chosen strategy, and unstated risks and assumptions;
3. surfaces any issues one-by-one for confirmation — accept the reviewer's
   suggestion, dismiss it, or type your own. Confirmed resolutions are
   appended to the plan returned to the agent.

The reviewer's thinking stream renders live as `✎ thinking` (dim italic,
capped at 9 lines by default — `HK2_HIDE_THINKING=0` for the full stream),
followed by its analysis, which also streams. Reviews run with reasoning
enabled and no hk2-side deadline — hk2 does not cut the review off itself,
but you can still abort, and network failures, provider disconnects, or
process termination can still end it.

Plan review is active only in interactive TTY mode and is best-effort: any
failure returns the already-confirmed plan unchanged.

## Code review

Two forms exist, sharing one implementation:

- **Automatic** — `HK2_ENABLE_CODEREVIEW=1` (default off): after an entire
  plan finishes executing, hk2 reviews the completed result — the
  working-tree diff, the changed files, and the agent's final summary — for
  correctness, completeness, and quality.
- **Manual** — `/review code` runs the same regression check on the
  just-completed task in the current conversation. Only the original task
  request and the completed result are sent to the review model — the task's
  implementation context is ignored so it cannot influence the review
  (fresh-eyes check). `/review plan` is reserved and not implemented yet.

The reviewer's analysis streams live (requirement re-analysis, per-point
coverage check, correctness check, conclusion); issues it finds are listed
one-by-one with detail and a suggestion. `--model=<provider>/<model-id>`
picks the model for a manual review.

### UNKNOWN verdicts

Only the machine-readable verdict JSON is parsed; it is never shown raw. A
reply whose verdict cannot be parsed is reported as **UNKNOWN** — never as
"no issues found". Treat UNKNOWN as "review inconclusive", not as success.

## Review models

Both reviews use the phase-model mechanism:

```text
/model set-phase --phase=plan-review local/mymodel
/model set-phase --phase=code-review local/mymodel
```

When unset, the session model reviews. If a configured review model is
unreachable, the review is **skipped** with a warning — never silently
re-run on a different model, which would change what reviewed the plan or
code. (`rewrite-query` / `request-assess` phase models *do* fall back to the
session model under `HK2_ENABLE_PHASEMODEL_FALLBACK`; the review phases are
deliberately stricter.)

Every phase-model fallback or skip is recorded in the session transcript
(`phaseModelFallback`, `skipped` + `error`) for auditing.

## Reasoning settings

- Reviews always run with reasoning enabled and no fixed timeout, regardless
  of the model's `--reasoning` flag.
- The request-clarity assessment can optionally run with deep reasoning via
  `HK2_ASSESS_REASONING=1` (default off) — see
  [Environment variables](../reference/environment-variables.md).

## Interruption behavior

- `esc` aborts a running review like any turn phase; partial analysis stays
  on screen, and no verdict is recorded.
- An interrupted *task* keeps its plan progress; resume restores the panel
  and a continuation cue ("continue") injects the task state so the agent
  continues rather than restarting.
- A failed or UNKNOWN review never blocks the turn: the result is reported
  and the turn ends normally.

## Related documentation

- [Agent workflow](../concepts/agent-workflow.md) — where review sits in the pipeline
- [Models, projects, and sessions](models-projects-and-sessions.md) — phase models
- [Environment variables](../reference/environment-variables.md) — `HK2_ENABLE_PLANREVIEW`, `HK2_ENABLE_CODEREVIEW`, and friends
