/*-------------------------------------------------------------------------
 *
 * Unit tests for the DEFERRED cross-process recovery (pendingRecovery):
 *   - reloadAll STASHES a previous process's interrupted planProgress into
 *     session.pendingRecovery instead of pinning it onto the live panel
 *     (fixes: "next launch shows the previous session's plan")
 *   - the stash is gated on an EMPTY conversation (mid-session /project
 *     switch must not inject the new project's stale plan)
 *   - promotePendingRecovery / discardPendingRecovery consume it one-shot
 *   - resumeSessionInto supersedes the boot stash with its own
 *     sessionId-keyed restore and clears the notice
 *   - buildRecoveryNotice renders the resume/drop hint
 *   - save → load → stash → promote → buildResumeContext full chain
 *
 * Run:  node --test test/recovery-notice.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createSession, buildCtx, reloadAll, resumeSessionInto, runTurn,
  promotePendingRecovery, discardPendingRecovery, buildRecoveryNotice,
  buildResumeContext,
} from '../src/commands/interactive.js';
import { saveTaskState, loadTaskState, clearTaskState } from '../lib/agent/task_state.js';
import { Transcript } from '../lib/agent/transcript.js';
import { ensureHome, registerProject, setCurrentProject } from '../lib/config/home.js';

function makePlanProgress() {
  return {
    summary: 'refactor the module',
    steps: [
      { goal: 'step A', strategy: 'alpha', status: 'done' },
      { goal: 'step B', strategy: 'beta', status: 'in_progress' },
      { goal: 'step C', strategy: 'gamma', status: 'pending' },
    ],
    current: 1,
  };
}

let __seq = 0;
async function makeSessionWithProject() {
  await ensureHome();
  const n = ++__seq;
  const src = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-recov-${n}-`));
  const proj = await registerProject({ name: `recovproj${n}`, sourcePath: src });
  await setCurrentProject(proj.id);
  const session = createSession(null);
  const ctx = buildCtx(session);
  return { session, ctx, proj };
}

/* ----- reloadAll: stash instead of pin ----- */

test('boot with persisted taskstate: plan is STASHED, not pinned', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();
  await saveTaskState(proj.id, {
    userRequest: 'do the big refactor',
    planProgress: makePlanProgress(),
    sessionId: 'sess-prev',
  });
  // Simulate the next launch: a FRESH session resolves the same project.
  await reloadAll(session, ctx);
  assert.ok(session.lastTask, 'lastTask restored for continue-cue recovery');
  assert.equal(session.lastTask.restored, true);
  assert.equal(session.planProgress, null, 'plan must NOT be pinned at boot (the bug)');
  assert.ok(session.pendingRecovery, 'plan stashed as pendingRecovery');
  assert.equal(session.pendingRecovery.planProgress.steps.length, 3);
  assert.ok(session.recoveryNotice, 'boot notice built');

  await clearTaskState(proj.id);
});

test('boot with no taskstate: nothing stashed, no notice', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();
  await reloadAll(session, ctx);
  assert.equal(session.pendingRecovery, null);
  assert.equal(session.recoveryNotice, null);
  assert.equal(session.planProgress, null);
});

test('boot with an all-done plan: nothing stashed (nothing to resume)', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();
  const done = makePlanProgress();
  for (const s of done.steps) s.status = 'done';
  await saveTaskState(proj.id, {
    userRequest: 'finished but crashed at exit',
    planProgress: done,
    sessionId: 'sess-x',
  });
  await reloadAll(session, ctx);
  assert.equal(session.pendingRecovery, null);
  await clearTaskState(proj.id);
});

test('mid-session project switch (messages non-empty): no stale-plan injection', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();
  // A live conversation is already in flight...
  session.messages.push({ role: 'user', content: 'we are mid-chat' });
  // ...and the (new) project carries an interrupted task on disk.
  await saveTaskState(proj.id, {
    userRequest: 'some other process task',
    planProgress: makePlanProgress(),
    sessionId: 'sess-other',
  });
  await reloadAll(session, ctx, { project: true, kb: false, model: false });
  assert.equal(session.pendingRecovery, null, 'no stash into a live conversation');
  assert.equal(session.planProgress, null);
  assert.equal(session.lastTask, null, 'no lastTask injection either');

  await clearTaskState(proj.id);
});

/* ----- promote / discard helpers ----- */

test('promotePendingRecovery: one-shot, promotes onto the panel', () => {
  const session = {
    planProgress: null,
    pendingRecovery: { planProgress: makePlanProgress(), userRequest: 'do the big refactor' },
  };
  const promoted = promotePendingRecovery(session);
  assert.equal(promoted, session.planProgress);
  assert.equal(session.planProgress.steps[1].status, 'in_progress');
  assert.equal(session.pendingRecovery, null, 'stash consumed');
  // Second call is a no-op.
  assert.equal(promotePendingRecovery(session), null);
});

test('promotePendingRecovery: never clobbers a live plan of this session', () => {
  const live = makePlanProgress();
  const session = {
    planProgress: live,
    pendingRecovery: { planProgress: makePlanProgress(), userRequest: 'old' },
  };
  assert.equal(promotePendingRecovery(session), null);
  assert.equal(session.planProgress, live, 'live plan wins');
  assert.equal(session.pendingRecovery, null, 'stash still consumed');
});

test('promotePendingRecovery: no-op on empty/absent stashes', () => {
  assert.equal(promotePendingRecovery(null), null);
  assert.equal(promotePendingRecovery({}), null);
  assert.equal(promotePendingRecovery({ pendingRecovery: { planProgress: null } }), null);
});

test('promotePendingRecovery: all-done stash is not promoted', () => {
  const done = makePlanProgress();
  for (const s of done.steps) s.status = 'done';
  const session = { planProgress: null, pendingRecovery: { planProgress: done } };
  assert.equal(promotePendingRecovery(session), null);
  assert.equal(session.planProgress, null);
});

test('discardPendingRecovery: clears stash and notice', () => {
  const session = {
    pendingRecovery: { planProgress: makePlanProgress() },
    recoveryNotice: 'x',
    planProgress: null,
  };
  discardPendingRecovery(session);
  assert.equal(session.pendingRecovery, null);
  assert.equal(session.recoveryNotice, null);
  discardPendingRecovery(null); // no-throw
});

/* ----- buildRecoveryNotice ----- */

test('buildRecoveryNotice: renders request + step count + resume hint', () => {
  const session = { pendingRecovery: { planProgress: makePlanProgress(), userRequest: 'do the big refactor' } };
  const notice = buildRecoveryNotice(session);
  assert.ok(notice.includes('do the big refactor'));
  assert.ok(notice.includes('1/3'), `step count rendered: ${notice}`);
  assert.ok(/continue|请继续/.test(notice));
  assert.equal(buildRecoveryNotice({}), null);
  assert.equal(buildRecoveryNotice({ pendingRecovery: { planProgress: null } }), null);
});

/* ----- resumeSessionInto supersedes the boot stash ----- */

test('resumeSessionInto: clears the boot stash; own restore keyed by sessionId', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();

  // Boot-time stash from a DIFFERENT session.
  await saveTaskState(proj.id, {
    userRequest: 'other session task',
    planProgress: makePlanProgress(),
    sessionId: 'sess-other',
  });
  await reloadAll(session, ctx);
  assert.ok(session.pendingRecovery, 'boot stashed');

  const prev = new Transcript(proj.id, 'sess-target');
  await prev.logUser('hello');

  const ok = await resumeSessionInto(session, 'sess-target');
  assert.equal(ok, true);
  assert.equal(session.pendingRecovery, null, 'boot stash cleared by resume');
  assert.equal(session.recoveryNotice, null);
  // taskstate belongs to a different session → no restore at all.
  assert.equal(session.lastTask, null);
  assert.equal(session.planProgress, null);

  await clearTaskState(proj.id);
});

test('resumeSessionInto: SAME session taskstate still restores directly (regression)', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();

  const prev = new Transcript(proj.id, 'sess-task');
  await prev.logUser('do the big refactor');
  await saveTaskState(proj.id, {
    userRequest: 'do the big refactor',
    planProgress: makePlanProgress(),
    sessionId: 'sess-task',
  });

  const ok = await resumeSessionInto(session, 'sess-task');
  assert.equal(ok, true);
  assert.ok(session.lastTask, 'lastTask restored');
  assert.equal(session.lastTask.userRequest, 'do the big refactor');
  // Resuming THAT session keeps its plan directly live: the conversation
  // context (messages) is the plan's own, so pinning is correct here.
  assert.ok(session.planProgress);
  assert.equal(session.pendingRecovery, null);

  await clearTaskState(proj.id);
});

/* ----- full chain: save → load → stash → promote → resume context ----- */

test('save → reloadAll stash → promote → buildResumeContext chain', async () => {
  const { session, ctx, proj } = await makeSessionWithProject();
  await saveTaskState(proj.id, {
    userRequest: 'refactor the plan-progress module',
    planProgress: makePlanProgress(),
    sessionId: 'sess-prev',
  });
  await reloadAll(session, ctx);
  assert.ok(session.pendingRecovery);

  promotePendingRecovery(session);
  const msg = buildResumeContext(session);
  assert.ok(msg.includes('refactor the plan-progress module'));
  assert.ok(msg.includes('step B'), 'plan lines feed the resume injection');

  await clearTaskState(proj.id);
});

/* ----- runTurn integration: tier-1 promotion / finally discard ------------- */
// These drive the REAL runTurn with a stashed pendingRecovery — the
// integration path the helper tests above cannot see (promotion ordering vs
// buildResumeContext, and the finally-path discard on a fresh-task turn).

function fakeRecUi() {
  const events = [];
  const rec = (name) => (...args) => { events.push([name, ...args]); };
  return {
    events,
    canPrompt: false, // keep runTurn off the interactive assessor/clarification
    progress: {
      phase: null, stopped: false, midLine: false,
      start(p) { this.phase = p; }, nextPhase(p) { this.phase = p; },
      reason() { this.phase = 'thinking'; }, resume(p) { this.phase = p; },
      pause() { this.phase = null; }, stop() { this.phase = null; this.stopped = true; },
      tick() { this.stopped = true; }, done() { this.phase = null; }, breakLine() {},
    },
    spinnerStart(p) { rec('spinnerStart')(p); },
    phase(p) { rec('phase')(p); },
    phaseOnly(p) { rec('phaseOnly')(p); },
    setPhaseSafe(p) { rec('setPhaseSafe')(p); },
    statusRefresh() { rec('statusRefresh')(); },
    stream: {
      reset() {}, delta() {}, reasoning() {},
      flushReasoning() { return ''; }, flushMarkdown() { return ''; }, flush() { return ''; },
    },
    toolStart(call) { rec('toolStart')(call.name); },
    toolEnd(call) { rec('toolEnd')(call.name); },
    finishStream() { rec('finishStream')(); },
    noticeLines() {}, notice() {}, userEcho() {}, usageLine() {},
    cancelled() {}, interrupted() {}, failed(err) { rec('failed')(err.message); },
    retryNotice() {},
    confirm: async () => false,
    optionList: async () => null,
    freeText: async () => ({ text: '', cancelled: true }),
    onInterrupt() { return () => {}; },
  };
}

function fakeRt() {
  // Mirrors request_assess_context.test.js's fakeRt: a non-empty graph so the
  // assessment phase's gate (canAssess && graph) passes when enabled.
  return {
    name: 'recovery-notice-test',
    knowledgeBySpace: { holy: [], eden: [] },
    allKnowledge: () => [],
    bm: { query: () => [] },
    callgraph: { byId: {} },
    async requestGraph() {
      return {
        summary: 'recovery-notice test graph',
        symbols: [],
        knowledge: [],
        neighbors: [],
        conflicts: [],
      };
    },
  };
}

function makeAgentSession(llm) {
  const session = createSession(null);
  session.llm = llm;
  session.modelCfg = { ref: 'test/model', maxChars: 65536, temperature: 0.2, enableReasoning: false };
  session.rt = fakeRt();
  return session;
}

test('runTurn tier-1 "continue": promotes the stash BEFORE the resume injection', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const seenSystemMsgs = [];
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream(messages) {
        for (const m of messages) {
          if (m.role === 'system' && typeof m.content === 'string'
              && m.content.includes('Resuming an interrupted task')) {
            seenSystemMsgs.push(m.content);
          }
        }
        agentTimeSnapshots.push({
          hasPlan: !!sessionRef?.planProgress,
          stash: !!sessionRef?.pendingRecovery,
        });
        yield { type: 'delta', text: 'resumed work' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeAgentSession(llm);
    sessionRef = session;
    // Boot state: reloadAll restored lastTask and stashed the plan.
    session.lastTask = { userRequest: 'refactor the plan-progress module', restored: true };
    session.pendingRecovery = {
      planProgress: makePlanProgress(),
      userRequest: 'refactor the plan-progress module',
      sessionId: 'sess-prev',
    };
    const ctx = buildCtx(session);
    const ui = fakeRecUi();

    await runTurn('continue', session, ctx, ui, { continuation: true });

    assert.ok(agentTimeSnapshots.length >= 1, 'the agent loop fired');
    // PROMOTION, observed AT AGENT TIME: the stashed plan became the live
    // panel and the stash was consumed. (After a NORMAL return the panel is
    // cleared by finalizePlanProgress({turnCompleted:true}) — the pre-existing
    // task-complete contract — so assertions must snapshot inside the call.)
    const snap = agentTimeSnapshots[0];
    assert.ok(snap.hasPlan, 'stashed plan promoted onto the panel by agent time');
    assert.equal(snap.stash, false, 'stash consumed before the agent call');
    assert.equal(session.pendingRecovery, null, 'stash still null after the turn');
    // ORDERING (review issue 1): the resume injection must carry the promoted
    // plan's step lines, not just the bare original request.
    assert.equal(seenSystemMsgs.length, 1, 'exactly one resume injection');
    assert.ok(seenSystemMsgs[0].includes('refactor the plan-progress module'), 'original request present');
    assert.ok(seenSystemMsgs[0].includes('step B'), 'promoted plan steps feed the injection');
    assert.ok(seenSystemMsgs[0].includes('Current plan progress'), 'plan block header present');
    // statusRefresh fired for the panel change (grow transition).
    assert.ok(ui.events.some(e => e[0] === 'statusRefresh'));
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});

test('runTurn fresh task: finally discards the un-promoted stash', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const llm = {
      async *stream() {
        yield { type: 'delta', text: 'starting the new thing' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeAgentSession(llm);
    // Boot left a stale stash, but the user starts a brand-new task.
    session.pendingRecovery = {
      planProgress: makePlanProgress(),
      userRequest: 'the interrupted old task',
      sessionId: 'sess-prev',
    };
    session.recoveryNotice = '[recovery] ...';
    const ctx = buildCtx(session);
    const ui = fakeRecUi();

    await runTurn('build me a brand new feature', session, ctx, ui, { continuation: false });

    // The FINALLY path consumed the stash: the old plan can never resurface
    // paired with this (or any later) unrelated task.
    assert.equal(session.pendingRecovery, null, 'stash discarded by the finally path');
    assert.equal(session.recoveryNotice, null, 'notice cleared with it');
    assert.equal(session.planProgress, null, 'no stale plan was pinned');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});

test('runTurn tier-2 upgrade: promotes the stash when the rolled-back plan is absent', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  process.env.HK2_ENABLE_FOLLOWUP_FASTLANE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '1';
  try {
    const seenSystemMsgs = [];
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ clear: true, followup: true, confidence: 0.9, reason: 'advances the in-flight plan' }) };
          return;
        }
        if (/query rewriter/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ intent: 'advance', functionNames: [], keywords: ['advance'] }) };
          return;
        }
        for (const m of messages) {
          if (m.role === 'system' && typeof m.content === 'string'
              && m.content.includes('Resuming an interrupted task')) {
            seenSystemMsgs.push(m.content);
          }
        }
        agentTimeSnapshots.push({
          hasPlan: !!sessionRef?.planProgress,
          stash: !!sessionRef?.pendingRecovery,
        });
        yield { type: 'delta', text: 'advancing the stashed task' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeAgentSession(llm);
    sessionRef = session;
    // Boot state: lastTask restored (in-flight referent for the upgrade), NO
    // live plan, stash pending. A phrasing the tier-1 regex misses.
    session.lastTask = { userRequest: 'refactor the plan-progress module', restored: true };
    session.pendingRecovery = {
      planProgress: makePlanProgress(),
      userRequest: 'refactor the plan-progress module',
      sessionId: 'sess-prev',
    };
    const ctx = buildCtx(session);
    const ui = fakeRecUi();
    ui.canPrompt = true; // the assessor must run for the tier-2 upgrade

    await runTurn('那么按照刚才的方案推进吧', session, ctx, ui);

    assert.ok(agentTimeSnapshots.length >= 1, 'the agent loop fired');
    const snap = agentTimeSnapshots[0];
    assert.ok(snap.hasPlan, 'stashed plan promoted via the tier-2 upgrade (at agent time)');
    assert.equal(snap.stash, false, 'stash consumed before the agent call');
    assert.equal(session.pendingRecovery, null, 'stash still null after the turn');
    assert.equal(seenSystemMsgs.length, 1, 'tier-2 path also injects resume context');
    assert.ok(seenSystemMsgs[0].includes('step B'), 'and it carries the promoted plan steps');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_FOLLOWUP_FASTLANE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});
