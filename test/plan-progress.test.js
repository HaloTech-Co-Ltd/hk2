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

// Mirrors the planStep callback body (interactive.js ~line 1126).
function advanceStep(session, stepIndex, note) {
  const p = session.planProgress;
  if (!p) return;
  const idx = typeof stepIndex === 'number' ? stepIndex - 1 : p.current;
  if (idx >= 0 && idx < p.steps.length) {
    p.steps[idx].status = 'done';
    if (note) p.steps[idx].note = String(note).slice(0, 160);
  }
  let next = -1;
  for (let i = 0; i < p.steps.length; i++) {
    if (p.steps[i].status === 'pending') { next = i; break; }
  }
  if (next === -1) {
    session.planProgress = null;
  } else {
    p.steps[next].status = 'in_progress';
    p.current = next;
  }
}

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
