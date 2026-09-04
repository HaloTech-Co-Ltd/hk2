/*-------------------------------------------------------------------------
 *
 * Regression tests for the P0-1 deferred plan/lastTask lifecycle:
 *
 *   The OLD code cleared session.planProgress (in handleUserLine) and
 *   overwrote session.lastTask (top of runTurn) BEFORE the request-clarity
 *   assessment ran. A follow-up the continuation-cue regex missed
 *   ("执行下一步") therefore reached the assessor with its task context
 *   destroyed and was judged "unclear" on pure noise.
 *
 *   The NEW code defers both mutations until after buildSessionDigest has
 *   consumed them (assessment phase), with a pass-2-boundary fallback for
 *   turns where assessment never runs.
 *
 * Run:  node --test test/request_assess_context.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import { runTurn } from '../src/commands/turn.js';
import { createSession, buildCtx, buildSessionDigest, isContinuationCue, detectFollowupFast, shouldUpgradeToContinuation } from '../src/commands/session_ctx.js';

/* ----- helpers ------------------------------------------------------ */

// Full-surface fake ui (same shape as turn_ui.test.js's fakeUi).
function fakeUi({ canPrompt = true } = {}) {
  const events = [];
  const rec = (name) => (...args) => { events.push([name, ...args]); };
  return {
    events,
    canPrompt,
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

function fakeLlm({ chunks = ['ok'], assessVerdict } = {}) {
  return {
    async *stream(messages) {
      // Route by system prompt: the assessor call vs the main agent call.
      const sys = messages?.[0]?.content || '';
      if (assessVerdict && /assessing a user's request/i.test(sys)) {
        yield { type: 'delta', text: JSON.stringify(assessVerdict) };
        return;
      }
      for (const c of chunks) yield { type: 'delta', text: c };
      yield { type: 'usage', input: 42, output: 7 };
    },
  };
}

// Minimal KB runtime stub: non-empty graph so the assessment phase runs
// (canAssess && graph is the gate in runTurn).
function fakeRt() {
  return {
    name: 'assess-ctx-test',
    knowledgeBySpace: { holy: [], eden: [] },
    allKnowledge: () => [],
    bm: { query: () => [] },
    callgraph: { byId: {} },
    async requestGraph(q) {
      return {
        summary: 'matched assessRequest in turn.js',
        symbols: [],
        knowledge: [],
        neighbors: [],
        conflicts: [],
      };
    },
  };
}

function makeSession(llm, { rt = null } = {}) {
  const session = createSession(null);
  session.llm = llm;
  session.modelCfg = { ref: 'test/model', maxChars: 65536, temperature: 0.2, enableReasoning: false };
  session.rt = rt;
  return session;
}

function makePlan() {
  return {
    summary: 'improve request assessment',
    current: 0,
    steps: [
      { goal: 'step A', status: 'done', strategies: [] },
      { goal: 'step B', status: 'in_progress', strategies: [] },
      { goal: 'step C', status: 'pending', strategies: [] },
    ],
  };
}

/* ----- unit-level: digest still sees the ORIGINAL task ------------------ */

test('P0-1 unit: digest includes plan + original lastTask BEFORE the turn runs (context intact)', () => {
  // This mirrors what the digest-build site inside runTurn sees under the
  // deferred lifecycle: nothing has been cleared or overwritten yet.
  const session = {
    lastTask: { userRequest: '分析并改进 request assessing 机制' },
    planProgress: makePlan(),
    messages: [
      { role: 'user', content: '分析并改进 request assessing 机制' },
      { role: 'assistant', content: '计划已制定。输入"下一步"即可开始执行。' },
    ],
  };
  const digest = buildSessionDigest(session, '执行下一步');
  assert.match(digest, /In-flight task/);
  assert.match(digest, /Active plan progress:/);
  assert.match(digest, /\[in progress\] step B/);
});

/* ----- integration: the deferred lifecycle inside runTurn --------------- */

test('P0-1+P1: misclassified follow-up ("执行下一步") keeps plan + lastTask for the assessor, then transitions', async () => {
  // P1 note: with the fast lane ON, this exact scenario (active plan +
  // "执行下一步") is caught deterministically by the plan-advance rule and
  // never reaches the assessor. This test therefore disables the fast lane
  // (HK2_ENABLE_FOLLOWUP_FASTLANE=0) to verify the P0-1 deferred lifecycle
  // still protects the assessor when the deterministic rules miss (e.g.
  // "那么按照刚才的方案推进吧" — follow-up phrasing the regexes can't
  // enumerate).
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  process.env.HK2_ENABLE_FOLLOWUP_FASTLANE = '0';
  try {

    const seenDigests = [];
    const agentTimeSnapshots = [];
    // Use a phrasing the deterministic rules deliberately do NOT match, so
    // this exercises the assessor path even with the fast lane enabled in
    // other tests.
    const followupText = '那么按照刚才的方案推进吧';
    // Capture the sessionContext the assessor receives + the lastTask/
    // planProgress state at the moment the MAIN agent call fires (i.e. after
    // the digest-build site has run its deferred transition).
    let sessionRef = null;
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) {
          for (const m of messages) {
            if (typeof m.content === 'string' && m.content.includes('Current session context')) {
              seenDigests.push(m.content);
            }
          }
          yield { type: 'delta', text: JSON.stringify({ clear: true }) };
          return;
        }
        if (/query rewriter/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ intent: 'next step', functionNames: [], keywords: ['next'] }) };
          return;
        }
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
        });
        yield { type: 'delta', text: 'working on the next step' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: fakeRt() });
    sessionRef = session;
    session.lastTask = { userRequest: '分析并改进 request assessing 机制' };
    session.planProgress = makePlan();
    session.messages = [
      { role: 'user', content: '分析并改进 request assessing 机制' },
      { role: 'assistant', content: '分析完成，三步计划已制定。输入"下一步"即可开始。' },
    ];
    const ctx = buildCtx(session);
    const ui = fakeUi({ canPrompt: true });

    await runTurn(followupText, session, ctx, ui);

    // The assessor MUST have seen the original task + plan in its digest.
    assert.equal(seenDigests.length, 1, 'exactly one assessor call');
    const digest = seenDigests[0];
    assert.ok(digest.includes('分析并改进 request assessing 机制'), 'original request visible to the assessor');
    assert.ok(digest.includes('Active plan progress'), 'plan block visible to the assessor');
    assert.ok(digest.includes('[in progress] step B'), 'plan step statuses visible');
    // At the main agent call (AFTER the digest-build site): the deferred
    // transition has committed — lastTask points at THIS request and the
    // stale plan block was retired.
    assert.ok(agentTimeSnapshots.length >= 1, 'the main agent call fired');
    const snap = agentTimeSnapshots[0];
    assert.equal(snap.lastTask, followupText, 'lastTask committed to this request by agent-loop time');
    assert.equal(snap.hasPlan, false, 'stale plan block retired by agent-loop time (fresh-task classification)');
    // After the turn completed normally, the task-complete cleanup applies
    // (pre-existing semantics: !planProgress → lastTask = null).
    assert.equal(session.lastTask, null, 'normal completion clears lastTask (unchanged task-complete path)');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_FOLLOWUP_FASTLANE;
  }
});

test('P1: fast lane skips the whole pre-agent pipeline for a plan-advance directive', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  try {
    const calls = { rewrite: 0, assess: 0, agent: 0 };
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) { calls.assess++; yield { type: 'delta', text: JSON.stringify({ clear: true }) }; return; }
        if (/query rewriter/i.test(sys)) { calls.rewrite++; yield { type: 'delta', text: JSON.stringify({ intent: 'x', functionNames: [], keywords: [] }) }; return; }
        calls.agent++;
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
        });
        yield { type: 'delta', text: 'advancing the plan' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: fakeRt() });
    sessionRef = session;
    session.lastTask = { userRequest: '分析并改进机制' };
    session.planProgress = makePlan();
    session.messages = [
      { role: 'user', content: '分析并改进机制' },
      { role: 'assistant', content: '计划已制定。输入下一步即可开始。' },
    ];
    const ctx = buildCtx(session);
    const ui = fakeUi({ canPrompt: true });
    await runTurn('执行下一步', session, ctx, ui);
    assert.equal(calls.rewrite, 0, 'no rewrite LLM call on the fast lane');
    assert.equal(calls.assess, 0, 'no assessor LLM call on the fast lane');
    assert.equal(calls.agent, 1, 'the main agent call still fires');
    const snap = agentTimeSnapshots[0];
    assert.equal(snap.lastTask, '分析并改进机制', 'fast lane preserves the in-flight task through the agent loop');
    assert.equal(snap.hasPlan, true, 'fast lane keeps the live plan block through the agent loop');
    const phases = ui.events.filter(e => e[0] === 'spinnerStart' || e[0] === 'phase').map(e => e[1]);
    assert.ok(phases.includes('waiting for model'), 'fast lane starts directly on the model wait');
    assert.ok(!phases.includes('rewriting query'), 'no rewrite phase on the fast lane');
    assert.ok(!phases.includes('assessing request'), 'no assessment phase on the fast lane');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
  }
});

test('P1: fast lane OFF via HK2_ENABLE_FOLLOWUP_FASTLANE=0 restores the assessed pipeline', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  process.env.HK2_ENABLE_FOLLOWUP_FASTLANE = '0';
  try {
    const calls = { rewrite: 0, assess: 0, agent: 0 };
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) { calls.assess++; yield { type: 'delta', text: JSON.stringify({ clear: true }) }; return; }
        if (/query rewriter/i.test(sys)) { calls.rewrite++; yield { type: 'delta', text: JSON.stringify({ intent: 'x', functionNames: [], keywords: [] }) }; return; }
        calls.agent++;
        yield { type: 'delta', text: 'working' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: fakeRt() });
    session.planProgress = makePlan();
    const ctx = buildCtx(session);
    const ui = fakeUi({ canPrompt: true });
    await runTurn('执行下一步', session, ctx, ui);
    assert.ok(calls.rewrite >= 1, 'rewrite runs with the fast lane off');
    assert.ok(calls.assess >= 1, 'assessor runs with the fast lane off');
    assert.equal(calls.agent, 1, 'main agent fires once');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_FOLLOWUP_FASTLANE;
  }
});

test('P0-1: with assessment disabled the fresh-task transition still happens (pass-2 boundary fallback)', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream() {
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
        });
        yield { type: 'delta', text: 'ok' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: null });
    sessionRef = session;
    session.lastTask = { userRequest: '旧任务' };
    session.planProgress = makePlan();
    const ctx = buildCtx(session);
    const ui = fakeUi();
    await runTurn('全新的任务', session, ctx, ui);
    const snap = agentTimeSnapshots[0];
    assert.equal(snap.lastTask, '全新的任务', 'lastTask committed at the fallback boundary (agent-loop time)');
    assert.equal(snap.hasPlan, false, 'stale plan retired at the fallback boundary');
    assert.equal(session.planProgress, null, 'plan block stays retired after the turn');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});

test('P0-1: continuation keeps the in-flight task for the whole turn', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream() {
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
        });
        yield { type: 'delta', text: 'ok' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: null });
    sessionRef = session;
    session.lastTask = { userRequest: '旧任务' };
    session.planProgress = makePlan();
    const ctx = buildCtx(session);
    const ui = fakeUi();
    // A continuation cue: runTurn is called with continuation:true (the
    // production caller handleUserLine does the classification).
    await runTurn('继续', session, ctx, ui, { continuation: true });
    const snap = agentTimeSnapshots[0];
    assert.equal(snap.lastTask, '旧任务', 'continuation preserves the in-flight lastTask through the agent loop');
    assert.equal(snap.hasPlan, true, 'continuation keeps the live plan block through the agent loop');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});

test('P0-1: planActiveAtStart only counts a CONTINUATION\'s plan (Code Review gate semantics preserved)', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  process.env.HK2_ENABLE_CODEREVIEW = '1';
  try {
    const session = makeSession(fakeLlm(), { rt: null });
    session.lastTask = { userRequest: '旧任务' };
    session.planProgress = makePlan(); // stale block from the PREVIOUS task
    const ctx = buildCtx(session);
    const ui = fakeUi();
    await runTurn('一个全新的任务', session, ctx, ui);
    // The new task's turn must NOT fire the end-of-turn Code Review for the
    // previous task's plan: planActiveAtStart was false for a fresh input.
    const phases = ui.events.filter(e => e[0] === 'phase' || e[0] === 'spinnerStart').map(e => e[1]);
    assert.ok(!phases.some(p => /review/i.test(String(p))), 'no code review for a plan the turn never worked on');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
    delete process.env.HK2_ENABLE_CODEREVIEW;
  }
});

/* ----- P1: detectFollowupFast unit coverage ------------------------------ */

test('detectFollowupFast: rule table', () => {
  const withPlan = { planProgress: makePlan(), messages: [] };
  const noPlan = { planProgress: null, messages: [] };
  // Rule 1: continuation cue
  assert.equal(detectFollowupFast('continue', withPlan), 'continuation-cue');
  assert.equal(detectFollowupFast('请继续', withPlan), 'continuation-cue');
  // Rule 2: bare confirmation words
  assert.equal(detectFollowupFast('好的', withPlan), 'confirmation-word');
  assert.equal(detectFollowupFast('好的。', withPlan), 'confirmation-word');
  assert.equal(detectFollowupFast('开始吧', withPlan), 'confirmation-word');
  assert.equal(detectFollowupFast('sure', withPlan), 'confirmation-word');
  // Rule 3: bare number pick, ONLY when the assistant's tail has a numbered menu
  const withMenu = {
    planProgress: null,
    messages: [
      { role: 'assistant', content: 'Here are the options:\n1. refactor the parser\n2. rewrite from scratch\n\nWhich one?' },
    ],
  };
  assert.equal(detectFollowupFast('2', withMenu), 'menu-choice');
  assert.equal(detectFollowupFast('选项 1', withMenu), 'menu-choice');
  assert.equal(detectFollowupFast('option 2', withMenu), 'menu-choice');
  assert.equal(detectFollowupFast('2', noPlan), null, 'no menu in tail → not a menu choice');
  // Rule 4: plan-advance directive, ONLY with an active plan
  assert.equal(detectFollowupFast('执行下一步', withPlan), 'plan-advance');
  assert.equal(detectFollowupFast('下一步', withPlan), 'plan-advance');
  assert.equal(detectFollowupFast('按计划推进', withPlan), 'plan-advance');
  assert.equal(detectFollowupFast('开始执行', withPlan), 'plan-advance');
  assert.equal(detectFollowupFast('执行下一步', noPlan), null, 'no active plan → not a plan advance');
  assert.equal(detectFollowupFast('step 2', withPlan), 'plan-advance');
  // NEGATIVE cases: real fresh tasks must NOT match
  assert.equal(detectFollowupFast('refactor the auth module', withPlan), null);
  assert.equal(detectFollowupFast('帮我新增一个 /users 接口', withPlan), null);
  assert.equal(detectFollowupFast('先分析执行器模块的设计', withPlan), null);
  assert.equal(detectFollowupFast('', withPlan), null);
  assert.equal(detectFollowupFast(null, withPlan), null);
  // A confirmation word EMBEDDED in a larger request is not a bare confirmation
  assert.equal(detectFollowupFast('好的，那么再帮我看看另一个问题', withPlan), null);
  // 执行 followed by a concrete object is a fresh task, not plan advance
  assert.equal(detectFollowupFast('执行迁移脚本', withPlan), null);
});

/* ----- Tier-2 continuation upgrade: shouldUpgradeToContinuation ---------- */

test('shouldUpgradeToContinuation: rule table', () => {
  const followupVerdict = { clear: true, followup: true, confidence: 0.9, reason: 'advances the plan just proposed' };
  const noFollowupVerdict = { clear: true, followup: false, confidence: 0.9 };
  const lowConfVerdict = { clear: true, followup: true, confidence: 0.3, reason: 'maybe' };

  // Fires: regex said fresh, assessor says followup with confidence, task in flight
  const up = shouldUpgradeToContinuation(followupVerdict, { continuation: false, inFlight: true });
  assert.ok(up, 'upgrade fires');
  assert.equal(up.reason, 'advances the plan just proposed');
  assert.equal(up.confidence, 0.9);

  // Tier 1 already classified continuation → nothing to do
  assert.equal(shouldUpgradeToContinuation(followupVerdict, { continuation: true, inFlight: true }), null);
  // No assessment / no followup verdict → tier 1 stands
  assert.equal(shouldUpgradeToContinuation(null, { continuation: false, inFlight: true }), null);
  assert.equal(shouldUpgradeToContinuation({}, { continuation: false, inFlight: true }), null);
  assert.equal(shouldUpgradeToContinuation(noFollowupVerdict, { continuation: false, inFlight: true }), null);
  // Low confidence → no upgrade (default threshold 0.6)
  assert.equal(shouldUpgradeToContinuation(lowConfVerdict, { continuation: false, inFlight: true }), null);
  // Confidence omitted → default 1 (same default assessRequest applies)
  const upNoConf = shouldUpgradeToContinuation(
    { clear: true, followup: true, reason: '' },
    { continuation: false, inFlight: true }
  );
  assert.ok(upNoConf, 'omitted confidence defaults to 1 → upgrade fires');
  // No in-flight task (fresh session) → a follow-up has no referent
  assert.equal(shouldUpgradeToContinuation(followupVerdict, { continuation: false, inFlight: false }), null);
  // Boundary: confidence exactly at the threshold fires (>=)
  const boundary = shouldUpgradeToContinuation(
    { clear: true, followup: true, confidence: 0.6 },
    { continuation: false, inFlight: true }
  );
  assert.ok(boundary, 'confidence == threshold fires');
});

test('shouldUpgradeToContinuation: HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE is honored', () => {
  process.env.HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE = '0.9';
  try {
    const v = { clear: true, followup: true, confidence: 0.7 };
    assert.equal(shouldUpgradeToContinuation(v, { continuation: false, inFlight: true }), null,
      '0.7 below the raised 0.9 threshold → no upgrade');
  } finally {
    delete process.env.HK2_CONTINUATION_UPGRADE_MIN_CONFIDENCE;
  }
});

/* ----- Tier-2 continuation upgrade: runTurn integration ------------------- */

test('tier-2 upgrade: followup verdict rolls back the fresh-task commit and injects resume context', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  process.env.HK2_ENABLE_FOLLOWUP_FASTLANE = '0'; // deterministic rules deliberately miss this phrasing
  try {
    const agentTimeSnapshots = [];
    const seenSystemMsgs = [];
    let sessionRef = null;
    const followupText = '那么按照刚才的方案推进吧';
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ clear: true, followup: true, confidence: 0.9, reason: 'advances the just-proposed plan' }) };
          return;
        }
        if (/query rewriter/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ intent: 'advance plan', functionNames: [], keywords: ['plan'] }) };
          return;
        }
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
          systemMsgs: messages.filter(m => m.role === 'system').map(m => m.content.slice(0, 60)),
        });
        yield { type: 'delta', text: 'resuming the plan' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: fakeRt() });
    sessionRef = session;
    session.lastTask = { userRequest: '分析并改进 request assessing 机制' };
    session.planProgress = makePlan();
    session.messages = [
      { role: 'user', content: '分析并改进 request assessing 机制' },
      { role: 'assistant', content: '分析完成，三步计划已制定。输入“下一步”即可开始。' },
    ];
    const ctx = buildCtx(session);
    const ui = fakeUi({ canPrompt: true });
    await runTurn(followupText, session, ctx, ui);

    assert.ok(agentTimeSnapshots.length >= 1, 'the main agent call fired');
    const snap = agentTimeSnapshots[0];
    // The deferred fresh-task commit was ROLLED BACK: the original task and
    // the live plan block survive into the agent loop (continuation semantics).
    assert.equal(snap.lastTask, '分析并改进 request assessing 机制',
      'upgrade restores the ORIGINAL lastTask (interrupt recovery anchor)');
    assert.equal(snap.hasPlan, true, 'upgrade keeps the live plan block through the agent loop');
    // Resume context was injected (same message a tier-1 continuation gets).
    assert.ok(snap.systemMsgs.some(s => /Resuming an interrupted task/.test(s)),
      'tier-2 upgrade injects the resume-context system message');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_FOLLOWUP_FASTLANE;
  }
});

test('tier-2 upgrade: HK2_ENABLE_CONTINUATION_UPGRADE=0 keeps tier 1 as the sole decision-maker', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '1';
  process.env.HK2_ENABLE_FOLLOWUP_FASTLANE = '0';
  process.env.HK2_ENABLE_CONTINUATION_UPGRADE = '0';
  try {
    const agentTimeSnapshots = [];
    let sessionRef = null;
    const llm = {
      async *stream(messages) {
        const sys = messages?.[0]?.content || '';
        if (/assessing a user's request/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ clear: true, followup: true, confidence: 0.95, reason: 'advances the plan' }) };
          return;
        }
        if (/query rewriter/i.test(sys)) {
          yield { type: 'delta', text: JSON.stringify({ intent: 'x', functionNames: [], keywords: [] }) };
          return;
        }
        agentTimeSnapshots.push({
          lastTask: sessionRef?.lastTask?.userRequest ?? null,
          hasPlan: !!sessionRef?.planProgress,
        });
        yield { type: 'delta', text: 'working' };
        yield { type: 'usage', input: 42, output: 7 };
      },
    };
    const session = makeSession(llm, { rt: fakeRt() });
    sessionRef = session;
    session.lastTask = { userRequest: '旧任务' };
    session.planProgress = makePlan();
    session.messages = [
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: '计划已制定。' },
    ];
    const ctx = buildCtx(session);
    const ui = fakeUi({ canPrompt: true });
    await runTurn('那么按照刚才的方案推进吧', session, ctx, ui);
    const snap = agentTimeSnapshots[0];
    // Disabled → the deferred fresh-task commit stands (tier-1 semantics).
    assert.equal(snap.lastTask, '那么按照刚才的方案推进吧',
      'upgrade off: lastTask commits to THIS request (fresh-task semantics)');
    assert.equal(snap.hasPlan, false, 'upgrade off: stale plan block retired');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_FOLLOWUP_FASTLANE;
    delete process.env.HK2_ENABLE_CONTINUATION_UPGRADE;
  }
});
