# Agent workflow

English | [简体中文](../../zh-CN/concepts/agent-workflow.md)

This page explains what happens between pressing Enter and the final answer:
the pre-agent pipeline (fast lane, clarity assessment, query rewrite, KB
retrieval), the agent loop with its tools, planning and review, and the
end-of-turn knowledge capture. Every stage described here exists in the
shipped code — the main flow lives in `src/commands/turn.js` (`runTurn`).

## Overview

```mermaid
flowchart TD
    U[User input] --> SL{Slash command?}
    SL -- yes --> SC[Slash dispatcher<br/>/model /kb /project ...]
    SL -- no --> GATE{Model + project + KB<br/>initialized?}
    GATE -- no --> HINT[Refused with setup hint]
    GATE -- yes --> AC[Auto-compact check<br/>turn boundary only]
    AC --> FL{Follow-up fast lane?}
    FL -- yes --> LOOP
    FL -- no --> RW[Query rewrite<br/>LLM call] --> KB[KB retrieval<br/>symbols, call chains,<br/>knowledge, docs] --> ASSESS{Reasoning-enabled<br/>request assessment}
    ASSESS -- unclear --> MENU[Clarification menu] --> RW2[Re-rewrite with answer] --> KB2[Re-retrieve] --> SP
    ASSESS -- clear --> SP
    KB --> ASSESS
    SP[System prompt + KB context<br/>Supreme Code when non-empty] --> LOOP[Agent loop<br/>LLM call + tool calls]
    LOOP --> TOOLS{Tool calls?}
    TOOLS -- yes --> EXEC[Execute tools] --> QUEUE[Inject queued user input<br/>at the round boundary] --> LOOP
    TOOLS -- no --> ANS[Final answer]
    LOOP -.plan tool.-> MODE{Confirmation callback?}
    MODE -- yes --> CONFIRM[User chooses strategies<br/>+ optional plan review]
    MODE -- no --> AUTO[Recommended strategies<br/>auto-accepted<br/>autoAccepted:true]
    CONFIRM --> LOOP
    AUTO --> LOOP
    ANS --> EOT{End of turn gates:<br/>bash-search gate → update offer/capture;<br/>conflict sync (own gate);<br/>plan finalize; code review (own gate)}
```

## Pre-agent pipeline

Before the agent loop sees the message, hk2 runs a bounded pipeline. All of
it is skipped for slash commands (they dispatch directly) and can be skipped
for obvious follow-ups:

1. **Gates** — a configured model and an initialized project KB are required;
   messages are refused with a setup pointer otherwise. The KB gate
   re-resolves the registry first, so a project registered in another
   terminal is picked up without a restart.
2. **Auto-compact check** — at the *start* of the turn (a safe boundary,
   never mid-turn), if `HK2_ENABLE_AUTOCOMPACT=1` (default on) and the
   measured context usage from the previous turn reached
   `HK2_AUTOCOMPACT_PCTUSED`% (default 90) of the context window, the earlier
   conversation is compacted: the last 4 user/assistant MESSAGES stay
   verbatim (messages, not 4 full turns — an alternating exchange is roughly
   two back-and-forth rounds),
   everything older (including tool results) is LLM-summarized into one
   system message, with naive truncation as the fallback. Before the turns
   are summarized away, durable user-stated facts are extracted into the
   session facts store (best-effort, fail-open), and the summarizer input
   keeps the conversation's head *and* tail so opening-stated facts reach
   the summary. Facts saved explicitly via `/remember` / the `remember`
   tool survive compaction by design; the automatic extraction is
   best-effort. hk2 always requests `enableReasoning:true`; this does not
   guarantee a separate reasoning stream from every provider. When tier 1 did
   not classify the input as a continuation, the existing assessment result can
   drive a tier-2 continuation upgrade when
   `HK2_ENABLE_CONTINUATION_UPGRADE=1`, confidence reaches
   `HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE` (default `0.6`), and an in-flight
   task exists. The upgrade reuses the assessment result, restores the original
   task state, injects resume context, and records `followupUpgrade`; it is not
   an additional LLM call.
3. **Follow-up fast lane** (`HK2_ENABLE_FOLLOWUP_FASTLANE`, default on) —
   inputs that are certainly conversational follow-ups skip the whole
   pre-agent pipeline and go straight to the agent loop, which sees the full
   conversation. Qualifying inputs: continuation cues ("continue", "请继续"),
   bare confirmations ("ok", "好的"), a bare number picking from the
   assistant's just-offered numbered menu, or a plan-advance directive
   ("执行下一步") while a plan is active.
4. **Query rewrite** (`HK2_ENABLE_QUERYREWRITE`, default on) — one LLM call
   rewrites the query into English function names + keywords for BM25
   retrieval. A phase model (`rewrite-query`) can drive it; after that model is
   successfully resolved, a call failure makes `HK2_ENABLE_PHASEMODEL_FALLBACK`
   (default on) re-run the phase on the session model, or skip it when set to 0.
   A stale ref resolving to `null` is silently treated as no override, while a
   resolution exception warns and uses the session model.
5. **KB retrieval** — the rewritten query retrieves related symbols,
   call-graph neighbors, 2-hop call chains, class membership, knowledge
   entries (Holy first), project docs, and structured doc tables
   (`lib/agent/graph.js`). Holy-over-Eden conflicts are detected here — a
   suppression notice prints immediately after retrieval — while the
   `supersededBy` stamping and sync report happen at end of turn.
6. **Request-clarity assessment** (`HK2_ENABLE_REQUEST_ASSESS`, default on) —
   one bounded LLM round judges whether the request is clear, *against the
   session context* (in-flight task, active plan, the assistant's latest
   message, recent turns, recorded session facts) so real follow-ups are not
   flagged. An unclear
   verdict surfaces a numbered clarification menu (with a free-text "other"
   option); the chosen answer is fed back into a second rewrite + retrieval
   pass. A low-confidence "unclear" verdict (below
   `HK2_ASSESS_MIN_CONFIDENCE`, default 0.8) is treated as clear, and any
   failure falls through to the normal rewrite — the assessment is
   best-effort.

## System prompt and KB context

The system prompt is built with a fixed section order (lib/agent/
`system_prompt.js`):

1. Agent identity, working style, and planning instructions
2. Knowledge-base-first policy and the preferred KB tools
3. Available tools and usage guidelines
4. Working directory and project info
5. `# Project Supreme Code (MUST OBEY — never violate)` — rendered only
   when the entry has items, always **before** every other injected context
   (model-level compliance; the storage protections on the entry itself are
   the hard limits)
6. `# Filesystem permission sandbox` — the effective permission summary
7. `# Knowledge-base context` — the per-request retrieval results
8. Project context files (e.g. README) and any appended tail

The KB context block goes into the system prompt on the first turn, and into
a dedicated per-turn system message afterwards. Content that mirrors real
files is suppressed when its source file is denied read permission (see
[Security and permissions](../guides/security-and-permissions.md)).

A second standing message — `## Session facts` — sits right after the main
system prompt on every turn. It carries the session's recorded facts and
survives compaction by design: facts explicitly saved via `/remember` or the
`remember` tool (and successfully persisted to disk) are preserved
deterministically, while the compaction-time extraction that rescues facts
from turns about to be summarized is best-effort — early statements are not
guaranteed to be captured. See
[Slash commands](../reference/slash-commands.md#remember).

## The agent loop

The loop (`lib/agent/loop.js`) streams a model reply, executes any tool
calls, feeds results back, and repeats until the model answers without
tools. Guardrails:

- **Tool result cache** — identical read-only tool calls within a `runLoop`
  reuse their results; the cache is cleared by bash/edit/write/ast_edit/
  resolve (not by `kb_save_knowledge` — see the tool reference).
- **Stuck detection** — the loop aborts on the **fourth** consecutive round
  with the same tool-call signature and result fingerprint (three repeats
  beyond the initial occurrence), or at an absolute cap of 1000 rounds. A
  coded `NO_PROGRESS_TURNS` 6-round no-progress guard exists but is currently unreachable (its
  condition requires zero pending tool calls, which returns first) — do not
  rely on it.
- **Mid-task input queueing** — plain text typed while a turn runs is queued
  and injected as in-task guidance at the next round boundary (after the
  current action completes, before the next LLM call), batched into one
  message; slash commands wait for the turn to end. On normal turn-ending
  paths anything not delivered mid-run becomes a fresh turn — nothing is
  lost (a crash or kill of the process is outside this guarantee). See
  [REPL and TUI](../guides/repl-and-tui.md).

### LLM retry boundary

An LLM retry restarts only the current LLM call. The failed attempt's body
deltas, reasoning buffer, and not-yet-executed tool calls are discarded; text
from earlier successfully completed tool rounds remains. The transcript,
`session.lastAnswer`, and Code Review input use the cleaned assistant text.
Usage accounting may still retain attempt-specific peaks, so it is not
documented as final-attempt-only or billed-total accounting.

The full tool registry is documented in [Agent tools](../reference/agent-tools.md).

## Planning

Planning is LLM-driven via the `plan` tool: when the model decides a task is
complex enough to benefit from an explicit strategy decomposition (multiple
distinct phases, a design choice, several affected subsystems), it calls
`plan` with a one-line summary and 2–5 ordered steps, each with 2–4 candidate
strategies (one marked recommended). Simple tasks skip straight to execution.
With an interactive confirmation callback, the user chooses per-step
strategies in a menu; the finalized plan drives a live progress panel advanced
by `plan_step`. Without that callback, recommended strategies are auto-accepted
and the result includes `autoAccepted:true`; no real progress panel exists.
Details in
[Planning and review](../guides/planning-and-review.md).

## End of turn

After the final answer streams (and the transcript is appended), hk2 runs a
fixed sequence:

1. **Auto-KB-update / `[kb learn]` offer** — this whole block runs **only
   when the turn recorded a qualifying bash source search** (grep/find/cat
   class commands on source files); with no such fallback recorded, none of
   it executes. When it does run: `HK2_ENABLE_AUTOUPDATEKB=1` triggers a
   silent incremental `/kb update`; otherwise hk2 prompts y/N.
2. **Knowledge capture** — reached only through the block above, and skipped
   when the agent already saved knowledge this turn (via
   `kb_save_knowledge`) or a capture was handled within the
   `HK2_KB_LEARN_COOLDOWN_MIN` window. One LLM extraction call proposes an
   entry; validation against existing KB (duplicate → skip, related →
   merge, conflict → resolve) runs when `HK2_KB_LEARN_VALIDATE=1`. Eden
   entries auto-commit with `HK2_ENABLE_AUTO_LEARN=1` (otherwise y/N);
   **Holy always prompts y/N**.
3. **Conflict sync** — a separate flow from the two above: Eden entries that
   conflict with a Holy entry get stamped `supersededBy: "holy:<id>"`.
4. **Code review** — a separate flow, gated on `HK2_ENABLE_CODEREVIEW=1`:
   after the loop returns normally, when this turn involved a plan (or
   started while continuing one) and the plan panel has been finalized by
   the normal-completion backstop, a reviewer checks the working-tree diff,
   changed files, and the final summary (see
   [Planning and review](../guides/planning-and-review.md)). The trigger
   does not strictly depend on the model having called `plan_step` for
   every step — the finalize-on-return backstop clears leftover panels,
   accepting that a mid-plan question in normal text can also clear it.

## Interruption and recovery

- **Interrupt** — `esc` (or Ctrl+C) mid-turn aborts the in-flight LLM call
  and tool round. Partial assistant text already streamed stays visible on
  the terminal screen, but it is **not** recorded into the transcript as a
  complete assistant turn; dangling tool calls are cleaned. Interrupted-task
  state (original request, summary, plan progress) is persisted with reason
  `interrupted`.
- **Resume** — in the same session, typing a continuation cue ("continue")
  injects the saved task state so the agent continues instead of restarting.
  After a restart, `hk2 --resume` replays the transcript *and* restores the
  interrupted-task state and the progress panel. Completed plans clear the
  state, so a later "continue" is a fresh request.

## Related documentation

- [Knowledge graph and retrieval](knowledge-graph-and-retrieval.md) — what retrieval actually queries
- [Planning and review](../guides/planning-and-review.md) — plans, plan review, code review
- [Environment variables](../reference/environment-variables.md) — every flag that gates a stage
