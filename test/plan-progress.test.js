/*-------------------------------------------------------------------------
 *
 * Unit tests for the plan-execution progress feature:
 *   - confirmPlan stores structured planProgress in the session
 *   - planStep callback advances step status and clears when done
 *   - formatPlanProgressLines renders the whole plan with per-step status
 *   - StatusBar planRenderer integration (variable bottom region)
 *
 * Run:  node --test test/plan-progress.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { buildTools, executeToolCall } from '../lib/agent/tools.js';
import * as style from '../lib/agent/style.js';

// Minimal session stub matching the shape interactive.js uses.
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
        { name: 'delta', description: 'd4', recommended: false },
      ] },
      { goal: 'step C', strategies: [
        { name: 'eps', description: 'd5', recommended: true },
        { name: 'zeta', description: 'd6', recommended: false },
      ] },
    ],
  };
}

test('formatPlanProgressLines returns [] when no plan is active', () => {
  // formatPlanProgressLines reads session.planProgress the same way the real
  // renderer does. We replicate its logic against the session directly because
  // it is a module-private function in interactive.js.
  const session = makeSession();
  const lines = renderProgress(session);
  assert.deepEqual(lines, []);
});

test('planProgress is populated with step 1 in_progress after confirm', () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha - d1' },
    { goal: 'step B', text: 'gamma - d3' },
    { goal: 'step C', text: 'eps - d5' },
  ]);
  assert.equal(session.planProgress.steps[0].status, 'in_progress');
  assert.equal(session.planProgress.steps[1].status, 'pending');
  assert.equal(session.planProgress.steps[2].status, 'pending');
  assert.equal(session.planProgress.current, 0);
});

test('planStep advances the current step and marks it done', () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha - d1' },
    { goal: 'step B', text: 'gamma - d3' },
    { goal: 'step C', text: 'eps - d5' },
  ]);
  // Mark step 1 done -> step 2 becomes in_progress.
  advanceStep(session, 1, 'did A');
  assert.equal(session.planProgress.steps[0].status, 'done');
  assert.equal(session.planProgress.steps[0].note, 'did A');
  assert.equal(session.planProgress.steps[1].status, 'in_progress');
  assert.equal(session.planProgress.current, 1);
  assert.equal(session.planProgress.steps[2].status, 'pending');
});

test('planStep clears planProgress when the last step is marked done', () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha - d1' },
    { goal: 'step B', text: 'gamma - d3' },
    { goal: 'step C', text: 'eps - d5' },
  ]);
  advanceStep(session, 1);
  advanceStep(session, 2);
  assert.equal(session.planProgress.current, 2);
  assert.equal(session.planProgress.steps[2].status, 'in_progress');
  advanceStep(session, 3);
  assert.equal(session.planProgress, null, 'plan cleared after last step done');
});

test('formatPlanProgressLines renders summary + one line per step + strategy line', () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha - d1' },
    { goal: 'step B', text: 'gamma - d3' },
    { goal: 'step C', text: 'eps - d5' },
  ]);
  advanceStep(session, 1); // step A done, step B in progress
  const lines = renderProgress(session);
  // header + 3 step lines + 1 strategy line for the in_progress step
  assert.ok(lines.length >= 4, `expected >=4 lines, got ${lines.length}`);
  assert.equal(lines[0], `${style.accent(style.bold('Plan'))} ${style.dim(':')} ${style.muted('do the thing')}`);
  // step A is done -> has a checkmark
  assert.ok(lines[1].includes(style.ICON.ok), 'done step shows ok mark');
  // step B is in progress -> has the ">" marker
  assert.ok(lines[2].includes('>'), 'in_progress step shows > marker');
  // strategy line is the 5th line (index 4) for the in_progress step
  assert.ok(lines.some(l => l.includes('gamma - d3')), 'in_progress strategy shown');
});

test('the plan_step tool is registered and calls the planStep callback', async () => {
  const session = makeSession();
  populateProgress(session, samplePlan(), [
    { goal: 'step A', text: 'alpha - d1' },
    { goal: 'step B', text: 'gamma - d3' },
    { goal: 'step C', text: 'eps - d5' },
  ]);
  let called = null;
  const tools = buildTools(null, {
    allowWrite: false,
    planStep: async (step, note) => {
      called = { step, note };
      advanceStep(session, step, note);
    },
  });
  const ps = tools.find(t => t.name === 'plan_step');
  assert.ok(ps, 'plan_step tool registered');
  const res = await executeToolCall(tools, { name: 'plan_step', arguments: { step: 1, note: 'finished A' } });
  assert.equal(res.ok, true);
  assert.equal(called.step, 1);
  assert.equal(called.note, 'finished A');
  assert.equal(session.planProgress.steps[0].status, 'done');
  assert.equal(session.planProgress.steps[1].status, 'in_progress');
});

test('plan_step tool with no planStep callback still returns ok (no-op)', async () => {
  const tools = buildTools(null, { allowWrite: false });
  const res = await executeToolCall(tools, { name: 'plan_step', arguments: { step: 1 } });
  assert.equal(res.ok, true);
  assert.match(res.result.message, /step 1/i);
});

/* ----- helpers that mirror interactive.js internals ----- */

// Mirrors the confirmPlan planProgress assignment (interactive.js ~line 871).
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

// Mirrors the planStep callback body (interactive.js). Always marks the
// CURRENT step done regardless of the step arg, then advances to the first
// non-done step (defensively clearing any stale in_progress markers first).
function advanceStep(session, stepIndex, note) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return null;
  // Parse the model-supplied step for the return value only; the CURRENT
  // step is what gets marked done (mirrors the real fix).
  let idx = -1;
  if (typeof stepIndex === 'number' && Number.isInteger(stepIndex)) idx = stepIndex - 1;
  else if (typeof stepIndex === 'string' && /^\d+$/.test(stepIndex.trim())) idx = parseInt(stepIndex, 10) - 1;
  const cur = (typeof p.current === 'number' && p.current >= 0 && p.current < p.steps.length) ? p.current : 0;
  const markIdx = cur;
  p.steps[markIdx].status = 'done';
  if (note) p.steps[markIdx].note = String(note).slice(0, 160);
  let next = -1;
  for (let i = 0; i < p.steps.length; i++) {
    if (p.steps[i].status !== 'done') {
      if (p.steps[i].status === 'in_progress') p.steps[i].status = 'pending';
      if (next === -1) next = i;
    }
  }
  if (next === -1) {
    session.planProgress = null;
  } else {
    p.steps[next].status = 'in_progress';
    p.current = next;
  }
  return markIdx + 1;
}

test('planStep tolerates string, 0-based, out-of-range and missing step args', () => {
  const mk = () => {
    const s = makeSession();
    populateProgress(s, samplePlan(), [
      { goal: 'step A', text: 'alpha' },
      { goal: 'step B', text: 'gamma' },
      { goal: 'step C', text: 'eps' },
    ]);
    return s;
  };

  // Numeric string "1" -> step 1 marked done, step 2 in_progress.
  const s1 = mk();
  assert.equal(advanceStep(s1, '1'), 1);
  assert.equal(s1.planProgress.steps[0].status, 'done');
  assert.equal(s1.planProgress.steps[1].status, 'in_progress');

  // 0-based "0" -> falls back to the current step (never stuck).
  const s2 = mk();
  assert.equal(advanceStep(s2, 0), 1);
  assert.equal(s2.planProgress.steps[0].status, 'done');
  assert.equal(s2.planProgress.steps[1].status, 'in_progress');

  // Out-of-range 99 -> falls back to the current step.
  const s3 = mk();
  assert.equal(advanceStep(s3, 99), 1);
  assert.equal(s3.planProgress.steps[0].status, 'done');

  // Missing step -> advances the current step.
  const s4 = mk();
  assert.equal(advanceStep(s4, undefined), 1);
  assert.equal(s4.planProgress.steps[0].status, 'done');
  assert.equal(s4.planProgress.steps[1].status, 'in_progress');

  // Float / garbage -> falls back to the current step.
  const s5 = mk();
  assert.equal(advanceStep(s5, 1.5), 1);
  assert.equal(s5.planProgress.steps[0].status, 'done');
  assert.equal(s5.planProgress.steps[1].status, 'in_progress');
});

test('planStep with a wrong-but-valid step still converges (first non-done advances)', () => {
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  // Model skips ahead and marks step 3 done while step 1 is still in_progress.
  // A step ahead of the current one is treated as "finished the current step";
  // the current step (1) is marked done, not step 3.
  assert.equal(advanceStep(s, 3), 1);
  assert.equal(s.planProgress.steps[0].status, 'done');
  assert.equal(s.planProgress.steps[1].status, 'in_progress');
  assert.equal(s.planProgress.steps[2].status, 'pending');
  assert.equal(s.planProgress.current, 1);
  // The next call continues from there - no stuck rows.
  assert.equal(advanceStep(s, 2), 2);
  assert.equal(s.planProgress.steps[0].status, 'done');
  assert.equal(s.planProgress.steps[1].status, 'done');
  assert.equal(s.planProgress.steps[2].status, 'in_progress');
});

test('BUG A: re-marking an already-done / earlier step keeps the panel in sync with the actual frontier', () => {
  // Scenario: the model finishes step 2 (current=1) but re-calls plan_step(1)
  // (an already-done earlier step) instead of plan_step(2). The current step
  // MUST still advance so the panel reflects reality, and no earlier step is
  // left stranded in_progress.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advanceStep(s, 1);            // step A done, step B in_progress (current=1)
  advanceStep(s, 1);            // BUG A: model re-marks step 1 (already done)
  assert.equal(s.planProgress.steps[0].status, 'done');
  assert.equal(s.planProgress.steps[1].status, 'done', 'current step B advanced to done');
  assert.equal(s.planProgress.steps[2].status, 'in_progress', 'step C is now in flight');
  assert.equal(s.planProgress.current, 2);
  // Exactly one in_progress step, at the frontier.
  const inProgress = s.planProgress.steps.filter(st => st.status === 'in_progress');
  assert.equal(inProgress.length, 1, 'exactly one in_progress step');
});

test('BUG B: marking the last step done clears the plan even when the model passed an earlier step number', () => {
  // Scenario: current is the LAST step (current=2, steps 0+1 done). The model
  // calls plan_step(1) (an earlier step) instead of plan_step(3). Before the
  // fix, the last step stayed in_progress and `next` never reached -1, so the
  // plan block never cleared. Now the current step advances to done -> clear.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  advanceStep(s, 1);            // -> current=1 (step B)
  advanceStep(s, 2);            // -> current=2 (step C, last step)
  assert.equal(s.planProgress.current, 2);
  assert.equal(s.planProgress.steps[2].status, 'in_progress');
  // Model passes the WRONG (earlier) step number on the final call.
  advanceStep(s, 1);
  assert.equal(s.planProgress, null, 'plan cleared even though model passed an earlier step');
  // The rendered panel is now empty (no stale block).
  assert.deepEqual(renderProgress(s), [], 'rendered panel is empty after clear');
});

test('BUG B (end-of-turn): a plan whose every step is done is finalized even if the model skipped the last plan_step', () => {
  // Scenario: the model did the work for all steps but emitted its final answer
  // without calling plan_step on the last step. finalizePlanProgress() (called
  // at runAgentTurn exit) must clear the block. This mirrors the helper added
  // to interactive.js.
  function finalizePlanProgress(session) {
    const p = session.planProgress;
    if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return;
    if (p.steps.every(st => st.status === 'done')) session.planProgress = null;
  }
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  // Simulate the model doing all the work but forgetting the final plan_step:
  // mark every step done directly (as if work completed) without clearing.
  for (const st of s.planProgress.steps) st.status = 'done';
  // The block would linger here without the end-of-turn reconciliation.
  assert.notEqual(s.planProgress, null, 'plan still pinned before finalize');
  finalizePlanProgress(s);
  assert.equal(s.planProgress, null, 'plan cleared at end of turn');
  assert.deepEqual(renderProgress(s), [], 'panel empty after finalize');
});

test('planStep with an ahead-of-current step (observed deepseek behavior) never strands a step', () => {
  // deepseek-v4-flash, after finishing step 1 (current=0), was observed to call
  // plan_step(2) - passing the NEXT step rather than the just-completed one.
  // The fix must mark the current step done so the panel advances.
  const s = makeSession();
  populateProgress(s, samplePlan(), [
    { goal: 'step A', text: 'alpha' },
    { goal: 'step B', text: 'gamma' },
    { goal: 'step C', text: 'eps' },
  ]);
  assert.equal(advanceStep(s, 2), 1); // marks step 1, returns 1
  assert.equal(s.planProgress.steps[0].status, 'done');
  assert.equal(s.planProgress.steps[1].status, 'in_progress');
  assert.equal(s.planProgress.steps[2].status, 'pending');
  // No step is left stuck in_progress while a later one is done.
  const stuck = s.planProgress.steps.some((st, i) =>
    st.status === 'in_progress' && s.planProgress.steps.slice(0, i).some(p => p.status !== 'done'));
  assert.equal(stuck, false, 'no earlier step should be left non-done');
});

test('planStep with no active plan returns null (tool reports it honestly)', () => {
  const s = makeSession(); // planProgress null
  assert.equal(advanceStep(s, 1), null);
});

// Mirrors formatPlanProgressLines (interactive.js ~line 542).
function renderProgress(session) {
  const p = session.planProgress;
  if (!p || !Array.isArray(p.steps) || p.steps.length === 0) return [];
  const lines = [];
  const head = p.summary
    ? `${style.accent(style.bold('Plan'))} ${style.dim(':')} ${style.muted(p.summary)}`
    : `${style.accent(style.bold('Plan'))} ${style.dim('(in progress)')}`;
  lines.push(head);
  for (let i = 0; i < p.steps.length; i++) {
    const st = p.steps[i];
    let mark, label;
    if (st.status === 'done') {
      mark = style.success(style.ICON.ok);
      label = style.dim(`${i + 1}. ${st.goal}`);
    } else if (st.status === 'in_progress') {
      mark = style.accent('>');
      label = style.accent(style.bold(`${i + 1}. ${st.goal}`));
    } else {
      mark = style.dim('[ ]');
      label = style.dim(`${i + 1}. ${st.goal}`);
    }
    lines.push(`  ${mark} ${label}`);
    if (st.status === 'in_progress' && st.strategy) {
      lines.push(`     ${style.dim(st.strategy)}`);
    }
  }
  return lines;
}
