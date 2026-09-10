/*-------------------------------------------------------------------------
 *
 * Unit tests for the plan-execution progress feature:
 *   - confirmPlan stores structured planProgress in the session
 *   - advancePlanStep (the REAL exported state machine) advances step status
 *     and clears when done
 *   - formatPlanProgressLines renders the whole plan with per-step status
 *   - finalizePlanProgress end-of-turn reconciliation (both modes)
 *   - StatusBar planRenderer integration (variable bottom region)
 *
 * IMPORTANT: these tests import the REAL state-machine functions
 * (advancePlanStep / finalizePlanProgress) from status_format.js — the
 * previous suite ran local mirror copies, which drifted from the production
 * logic and let "panel stuck after task completion" regressions slip past
 * the suite. Do NOT reintroduce local mirrors here.
 *
 * Run:  node --test test/plan-progress.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { buildTools, executeToolCall } from '../lib/agent/tools.js';
import * as style from '../lib/agent/style.js';
import {
  advancePlanStep,
  finalizePlanProgress,
  formatPlanProgressLines,
} from '../src/commands/status_format.js';

// Minimal session stub matching the shape turn.js uses.
function makeSession() {
  return { planProgress: null };
}

// A fake plan matching normalizePlanInput's expected shape.
function samplePlan() {
  return {
    summary: 'do the thing',
    steps: [
      { goal: 'step A', strategies: [
        { name: 'alpha', description: 'd1', recommended: true },
        { name: 'beta', description: 'd2', recommended: false },
      ] },
      { goal: 'step B', strategies: [
        { name: 'gamma', description: 'd3', recommended: true },
      ] },
      { goal: 'step C', strategies: [
        { name: 'eps', description: 'd5', recommended: true },
      ] },
    ],
  };
}

/* ----- panel rendering with no plan ----- */

test('no plan active -> formatPlanProgressLines returns [] (panel empty)', () => {
  const session = makeSession();
  const lines = formatPlanProgressLines(session);
  assert.deepEqual(lines, []);
});

/* ----- confirmPlan populates planProgress (shape) ----- */

test('confirmPlan stores structured planProgress: first step in_progress, rest pending', () => {
  // Mirrors the assignment in confirmPlan (turn.js) — shape contract only.
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  assert.equal(session.planProgress.summary, 'do the thing');
  assert.equal(session.planProgress.current, 0);
  assert.equal(session.planProgress.steps[0].status, 'in_progress');
  assert.equal(session.planProgress.steps[1].status, 'pending');
  assert.equal(session.planProgress.steps[2].status, 'pending');
});

/* ----- advancePlanStep: the real state machine ----- */

test('advancePlanStep marks the current step done and advances to the next', () => {
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  assert.equal(advancePlanStep(s, 1), 1);
  assert.equal(s.planProgress.steps[0].status, 'done');
  assert.equal(s.planProgress.steps[1].status, 'in_progress');
  assert.equal(s.planProgress.steps[2].status, 'pending');
  assert.equal(s.planProgress.current, 1);
});

test('advancePlanStep tolerates string, 0-based, out-of-range and missing step args', () => {
  const mk = () => {
    const s = makeSession();
    populateProgress(s, samplePlan(), [
      { goal: 'step A', text: 'alpha' },
      { goal: 'step B', text: 'gamma' },
      { goal: 'step C', text: 'eps' },
    ]);
    return s;
  };

  // Numeric string "1" -> still marks the CURRENT step (0) done.
  const s1 = mk();
  assert.equal(advancePlanStep(s1, '1'), 1);
  assert.equal(s1.planProgress.steps[0].status, 'done');
  assert.equal(s1.planProgress.steps[1].status, 'in_progress');

  // 0-based "0" -> falls back to the current step (never stuck).
  const s2 = mk();
  assert.equal(advancePlanStep(s2, 0), 1);
  assert.equal(s2.planProgress.steps[0].status, 'done');

  // Out-of-range 99 -> same: the current step advances.
  const s3 = mk();
  assert.equal(advancePlanStep(s3, 99), 1);
  assert.equal(s3.planProgress.steps[0].status, 'done');
  assert.equal(s3.planProgress.steps[1].status, 'in_progress');

  // Missing -> same.
  const s4 = mk();
  assert.equal(advancePlanStep(s4, undefined), 1);
  assert.equal(s4.planProgress.steps[0].status, 'done');

  // Numeric string of the NEXT step ("2", observed deepseek behavior) -> the
  // CURRENT step is what gets marked done.
  const s5 = mk();
  assert.equal(advancePlanStep(s5, 2), 1);
  assert.equal(s5.planProgress.steps[0].status, 'done');
  assert.equal(s5.planProgress.steps[1].status, 'in_progress');
  // No step is left stuck in_progress while a later one is done.
  const stuck = s5.planProgress.steps.some((st, i) =>
    st.status === 'in_progress' && s5.planProgress.steps.slice(0, i).some(p => p.status !== 'done'));
  assert.equal(stuck, false, 'no earlier step should be left non-done');
});

test('advancePlanStep with no active plan returns null', () => {
  const s = makeSession(); // planProgress null
  assert.equal(advancePlanStep(s, 1), null);
});

/* ----- BUG regressions (historical), now against the real functions ----- */

test('BUG A (stale in_progress): ahead-of-current call never strands a step', () => {
  // deepseek-v4-flash was observed calling plan_step(2) after finishing
  // step 1 — passing the NEXT step. Earlier code that looked only for the
  // first 'pending' left step 1 stuck in_progress forever.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advancePlanStep(s, 2); // model passes the NEXT step number
  const inProgress = s.planProgress.steps.filter(st => st.status === 'in_progress');
  assert.equal(inProgress.length, 1, 'exactly one in_progress step');
  assert.equal(inProgress[0], s.planProgress.steps[1], 'the NEW current step');
});

test('BUG B (wrong step cleared): model re-confirming an earlier step still advances the current one', () => {
  // current is the LAST step; the model passes an EARLIER step number.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advancePlanStep(s, 1);            // -> current=1 (step B)
  advancePlanStep(s, 2);            // -> current=2 (step C, last step)
  assert.equal(s.planProgress.current, 2);
  assert.equal(s.planProgress.steps[2].status, 'in_progress');
  // Model passes the WRONG (earlier) step number on the final call.
  advancePlanStep(s, 1);
  assert.equal(s.planProgress, null, 'plan cleared even though model passed an earlier step');
  assert.deepEqual(formatPlanProgressLines(s), [], 'rendered panel is empty after clear');
});

/* ----- finalizePlanProgress: end-of-turn reconciliation ----- */

test('BUG B (end-of-turn): a plan whose every step is done is finalized even without the last plan_step', () => {
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  for (const st of s.planProgress.steps) st.status = 'done';
  assert.notEqual(s.planProgress, null, 'plan still pinned before finalize');
  finalizePlanProgress(s);
  assert.equal(s.planProgress, null, 'plan cleared at end of turn');
  assert.deepEqual(formatPlanProgressLines(s), [], 'panel empty after finalize');
});

test('REGRESSION (the reported bug): turn ends normally with steps still pending -> turnCompleted clears the panel', () => {
  // Variant 1: the model skipped ALL plan_step calls (panel still on step 1).
  const s1 = makeSession();
  populateProgress(s1, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  // Turn completes normally (runLoop returned a final text answer): the
  // reconciliation must clear the block even though NO step is done.
  finalizePlanProgress(s1, { turnCompleted: true });
  assert.equal(s1.planProgress, null, 'panel cleared when the turn completed normally');
  assert.deepEqual(formatPlanProgressLines(s1), [], 'panel empty');

  // Variant 2: partial advancement — only step 1 marked done, the model then
  // finished everything and answered without more plan_step calls.
  const s2 = makeSession();
  populateProgress(s2, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advancePlanStep(s2, 1); // step 1 done, current=1
  finalizePlanProgress(s2, { turnCompleted: true });
  assert.equal(s2.planProgress, null, 'panel cleared despite mid-flight statuses');
});

test('interruption path (catch): a mid-flight plan SURVIVES conservative finalize', () => {
  // The catch path calls finalizePlanProgress WITHOUT turnCompleted — the
  // plan must survive so "请继续" can restore the panel (Holy:
  // interruption-recovery-mechanism). Only a fully-done plan clears.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advancePlanStep(s, 1); // step 1 done, current=1 (mid-flight)
  finalizePlanProgress(s); // conservative (catch path)
  assert.notEqual(s.planProgress, null, 'mid-flight plan survives the catch path');
  assert.equal(s.planProgress.current, 1);
  // Fully-done plans still clear on the catch path.
  advancePlanStep(s, 2);
  advancePlanStep(s, 3);
  finalizePlanProgress(s);
  assert.equal(s.planProgress, null, 'fully-done plan clears on the catch path');
});

/* ----- tool wiring ----- */

test('plan_step tool drives the REAL state machine via the planStep callback', async () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  const tools = buildTools(null, {
    allowWrite: false,
    planStep: async (step, note) => advancePlanStep(session, step, note),
  });
  const ps = tools.find(t => t.name === 'plan_step');
  assert.ok(ps, 'plan_step tool registered');
  const res = await executeToolCall(tools, { name: 'plan_step', arguments: { step: 1, note: 'finished A' } });
  assert.equal(res.ok, true);
  assert.match(res.result.message, /Marked plan step 1/i);
  assert.equal(session.planProgress.steps[0].status, 'done');
  assert.equal(session.planProgress.steps[0].note, 'finished A');
  assert.equal(session.planProgress.steps[1].status, 'in_progress');
});

test('plan_step without a progress callback acknowledges the report without state', async () => {
  const tools = buildTools(null, { allowWrite: false });
  const res = await executeToolCall(tools, { name: 'plan_step', arguments: { step: 1 } });
  assert.equal(res.ok, true);
  assert.match(res.result.message, /No interactive progress state is available/i);
  assert.doesNotMatch(res.result.message, /Marked .* as done|Advanced plan progress/);
});

/* ----- helpers ----- */

// Mirrors the confirmPlan planProgress assignment (turn.js) — SHAPE ONLY;
// the step-advancement logic itself is imported from status_format.js.
function populateProgress(session, plan, choices) {
  session.planProgress = {
    summary: plan.summary || '',
    steps: choices.map((c, i) => ({
      goal: c.goal,
      strategy: c.text,
      status: i === 0 ? 'in_progress' : 'pending',
    })),
    current: 0,
  };
}

test('plan_step callback with no active plan reports ignored instead of advancing', async () => {
  const tools = buildTools(null, { allowWrite: false, planStep: async () => null });
  const res = await executeToolCall(tools, { name: 'plan_step', arguments: { step: 999 } });
  assert.equal(res.ok, true);
  assert.match(res.result.message, /No active plan.*ignored/);
});
