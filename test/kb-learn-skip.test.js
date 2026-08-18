/*-------------------------------------------------------------------------
 *
 * Unit tests for the end-of-turn KB learn skip logic (interactive.js):
 *
 *   maybeOfferKbUpdate drives the end-of-turn pipeline. When the agent
 *   already persisted knowledge via kb_save_knowledge during the turn
 *   (session.kbSavedThisTurn), the redundant [kb learn] LLM extraction
 *   must be SKIPPED instead of re-learning the same thing. The skip must
 *   also fire when the user explicitly declined a proposal (cancelled),
 *   but NOT when the tool hard-errored.
 *
 * Run:  node --test test/kb-learn-skip.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createSession, maybeOfferKbUpdate, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { Transcript } from '../lib/agent/transcript.js';
import { ensureHome, registerProject, setCurrentProject } from '../lib/config/home.js';

/* ----- helpers ------------------------------------------------------- */

function mockCtx() {
  const lines = [];
  return {
    lines,
    print: (s) => lines.push(s),
    confirm: async () => false, // decline /kb update so runKbUpdate is skipped
  };
}

// A fake session whose LLM records every stream() call. learnNewKnowledge
// streams via session.llm.stream — callCount === 0 proves it was skipped.
function mockSession({ savedThisTurn = false, savedEntries = [] } = {}) {
  const s = createSession();
  s.project = { id: 'test-proj', name: 'test-proj', sourcePath: '/tmp/x' };
  s.bashSearchCommands = ['grep -r foo src/'];
  s.kbSavedThisTurn = savedThisTurn;
  s.kbSavedEntries = savedEntries;
  // learnNewKnowledge requires a user + assistant message in history.
  s.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'did the thing' },
  ];
  let callCount = 0;
  s.llm = {
    stream: async function* () {
      callCount++;
      yield { type: 'delta', text: '{"skip": true}' };
    },
  };
  // expose callCount via closure on the session object
  s._llmCallCount = () => callCount;
  return s;
}

/* ----- 1. saved this turn -> [kb learn] skipped ----------------------- */

test('maybeOfferKbUpdate skips [kb learn] when kb_save_knowledge already saved', async () => {
  const session = mockSession({ savedThisTurn: true, savedEntries: [{ id: 'my-entry', space: 'eden' }] });
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.equal(session._llmCallCount(), 0, 'LLM must NOT be called when knowledge was already saved');
  const skipLine = ctx.lines.find(l => l.includes('skipped') && l.includes('kb_save_knowledge'));
  assert.ok(skipLine, `expected a skip notice, got: ${JSON.stringify(ctx.lines)}`);
  assert.ok(skipLine.includes('eden:my-entry'), 'skip notice should list the saved entry');
});

/* ----- 2. not saved -> [kb learn] runs normally ----------------------- */

test('maybeOfferKbUpdate runs [kb learn] when nothing was saved this turn', async () => {
  const session = mockSession();
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.ok(session._llmCallCount() >= 1, 'LLM extraction should run when no save happened');
  assert.ok(ctx.lines.some(l => l.includes('[kb learn]')), 'expected [kb learn] output');
});

/* ----- 3. cancelled proposal also counts as handled ------------------- */

test('maybeOfferKbUpdate skips [kb learn] when the user declined a proposal', async () => {
  // cancelled: true (user saw the proposal and said no) — the model already
  // surfaced its knowledge; re-extracting would prompt the user again.
  const session = mockSession({ savedThisTurn: true, savedEntries: [] });
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.equal(session._llmCallCount(), 0, 'LLM must NOT be called for a handled (declined) proposal');
  assert.ok(ctx.lines.some(l => l.includes('skipped')), 'expected a skip notice');
});

/* ----- 4. hard error leaves the flag unset -> learn still runs --------- */

test('maybeOfferKbUpdate still learns when kb_save_knowledge errored', async () => {
  // { error } results never set kbSavedThisTurn (simulated here directly):
  const session = mockSession({ savedThisTurn: false });
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.ok(session._llmCallCount() >= 1, 'learn should still run after a hard tool error');
});

/* ----- 5. no bash-search fallbacks -> nothing offered at all ----------- */

test('maybeOfferKbUpdate is a no-op without bash search fallbacks', async () => {
  const session = mockSession();
  session.bashSearchCommands = [];
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.equal(session._llmCallCount(), 0);
  assert.equal(ctx.lines.length, 0, 'no output expected when there is nothing to offer');
});

/* ----- 6. new session starts with the flag reset ---------------------- */

test('createSession initializes kbSavedThisTurn/kbSavedEntries', async () => {
  const s = createSession();
  assert.equal(s.kbSavedThisTurn, false);
  assert.deepEqual(s.kbSavedEntries, []);
  assert.equal(s.kbLearnHandledAt, 0, 'cooldown anchor must start unset');
});

/* ----- 7. session-level cooldown gates follow-up turns ---------------- */

test('maybeOfferKbUpdate skips [kb learn] while the session cooldown is active', async () => {
  // Simulates a follow-up turn of the same task: the per-turn flag was reset,
  // but the session learned 2 minutes ago (e.g. previous turn's kb_save_knowledge).
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '15';
  try {
    const session = mockSession({ savedThisTurn: false });
    session.kbLearnHandledAt = Date.now() - 2 * 60_000;
    const ctx = mockCtx();
    await maybeOfferKbUpdate(session, ctx);
    assert.equal(session._llmCallCount(), 0, 'LLM must NOT be called while in cooldown');
    assert.ok(ctx.lines.some(l => l.includes('cooldown')), `expected a cooldown notice, got: ${JSON.stringify(ctx.lines)}`);
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

test('maybeOfferKbUpdate learns again after the cooldown expires', async () => {
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '15';
  try {
    const session = mockSession({ savedThisTurn: false });
    session.kbLearnHandledAt = Date.now() - 16 * 60_000; // past the 15min window
    const ctx = mockCtx();
    await maybeOfferKbUpdate(session, ctx);
    assert.ok(session._llmCallCount() >= 1, 'extraction should run once the cooldown expired');
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

test('cooldown disabled via HK2_KB_LEARN_COOLDOWN_MIN=0', async () => {
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '0';
  try {
    const session = mockSession({ savedThisTurn: false });
    session.kbLearnHandledAt = Date.now(); // learned THIS second
    const ctx = mockCtx();
    await maybeOfferKbUpdate(session, ctx);
    assert.ok(session._llmCallCount() >= 1, 'cooldown=0 must disable the gate entirely');
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

test('cooldown is OFF by default (unset env never suppresses [kb learn])', async () => {
  // The default IS 0: without an explicit positive window the gate must never
  // fire, even one second after a handled capture — the user, not a timer,
  // decides when learning is done.
  assert.equal(process.env.HK2_KB_LEARN_COOLDOWN_MIN, undefined, 'precondition: env must be unset');
  const session = mockSession({ savedThisTurn: false });
  session.kbLearnHandledAt = Date.now();
  const ctx = mockCtx();
  await maybeOfferKbUpdate(session, ctx);
  assert.ok(session._llmCallCount() >= 1, 'default (unset) must behave as cooldown=0');
  assert.equal(session.kbLearnCooldownMs, 0, 'memoized window should record 0');
});

/* ----- 8. resume restores the cooldown from the transcript ------------ */

// resumeSessionInto is not exported; we test the same scan contract it relies
// on by exercising maybeOfferKbUpdate with a restored anchor. The transcript
// scan itself is covered by the resume unit tests (test/session-resume). Here
// we assert the end-to-end effect: an anchor "restored from a transcript"
// (2 min old) suppresses the fallback in the resumed session's first turn.
test('resumed session with a recent learned_knowledge record skips [kb learn]', async () => {
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '15';
  try {
    const session = mockSession({ savedThisTurn: false });
    // What resumeSessionInto would have set from the transcript's last
    // learned_knowledge meta (2 minutes before "now").
    session.kbLearnHandledAt = Date.now() - 2 * 60_000;
    const ctx = mockCtx();
    await maybeOfferKbUpdate(session, ctx);
    assert.equal(session._llmCallCount(), 0);
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

/* ----- 9. successful save arms the cooldown for the next turn --------- */

test('a handled save this turn sets the session cooldown anchor', async () => {
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '15';
  try {
    const session = mockSession({ savedThisTurn: true, savedEntries: [{ id: 'e', space: 'eden' }] });
    const ctx = mockCtx();
    await maybeOfferKbUpdate(session, ctx);
    assert.ok(session.kbLearnHandledAt > 0, 'skip path must refresh the cooldown anchor');
    // And a second call in the same session (simulating the next turn, per-turn
    // flag reset) is still suppressed by the cooldown.
    session.kbSavedThisTurn = false;
    session.kbSavedEntries = [];
    const ctx2 = mockCtx();
    await maybeOfferKbUpdate(session, ctx2);
    assert.equal(session._llmCallCount(), 0, 'next turn within cooldown must skip too');
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

/* ----- 10. resumeSessionInto restores the anchor from the transcript --- */

let __projSeq = 0;

async function makeResumableSession() {
  await ensureHome();
  const n = ++__projSeq;
  const src = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-learn-${n}-`));
  const proj = await registerProject({ name: `learnproj${n}`, sourcePath: src });
  await setCurrentProject(proj.id);
  const session = createSession(null);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx);
  assert.ok(session.project, 'project resolved');
  return { session, ctx };
}

test('resume restores kbLearnHandledAt from a recent learned_knowledge meta', async () => {
  process.env.HK2_KB_LEARN_COOLDOWN_MIN = '15';
  try {
  const { session, ctx } = await makeResumableSession();

  // Previous session: user → assistant → learned_knowledge meta (just now).
  const prev = new Transcript(session.project.id, 'sess-learned');
  await prev.logUser('fix the bug');
  await prev.logAssistant('fixed');
  await prev.logMeta('learned_knowledge', { id: 'x', space: 'eden', title: 'X' });

  const before = Date.now();
  const ok = await ctx.resumeSession('sess-learned');
  assert.equal(ok, true);
  assert.ok(session.kbLearnHandledAt > before - 60_000 && session.kbLearnHandledAt <= Date.now(),
    `anchor should be restored to ~now, got ${session.kbLearnHandledAt}`);

  // End-to-end: the resumed session's first turn must skip [kb learn].
  session.bashSearchCommands = ['grep -r foo src/'];
  session.kbSavedThisTurn = false;
  session.kbSavedEntries = [];
  session.messages = [
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'ok' },
  ];
  session.llm = { stream: async function* () { throw new Error('must not be called'); } };
  const c = mockCtx();
  await maybeOfferKbUpdate(session, c);
  assert.ok(c.lines.some(l => l.includes('cooldown')), 'expected cooldown skip notice');
  } finally {
    delete process.env.HK2_KB_LEARN_COOLDOWN_MIN;
  }
});

test('resume restores kbLearnHandledAt from a kb_save_knowledge tool_call', async () => {
  const { session, ctx } = await makeResumableSession();
  const prev = new Transcript(session.project.id, 'sess-saved');
  await prev.logUser('fix');
  await prev.logToolCall(
    { id: 'call_1', name: 'kb_save_knowledge', arguments: '{"id":"e"}' },
    { ok: true, result: { saved: true, id: 'e', space: 'eden' } },
  );
  await prev.logAssistant('saved');

  const before = Date.now();
  const ok = await ctx.resumeSession('sess-saved');
  assert.equal(ok, true);
  assert.ok(session.kbLearnHandledAt > before - 60_000, 'anchor restored from tool_call');
});

test('resume leaves the anchor unset when nothing was ever learned', async () => {
  const { session, ctx } = await makeResumableSession();
  const prev = new Transcript(session.project.id, 'sess-plain');
  await prev.logUser('hi');
  await prev.logAssistant('hello');
  const ok = await ctx.resumeSession('sess-plain');
  assert.equal(ok, true);
  assert.equal(session.kbLearnHandledAt, 0, 'no learning evidence → anchor must stay unset');
});

test('resume ignores a hard-errored kb_save_knowledge tool_call', async () => {
  const { session, ctx } = await makeResumableSession();
  const prev = new Transcript(session.project.id, 'sess-errored');
  await prev.logToolCall(
    { id: 'call_1', name: 'kb_save_knowledge', arguments: '{"id":"e"}' },
    { ok: true, result: { error: 'Refused: no confirm callback' } },
  );
  const ok = await ctx.resumeSession('sess-errored');
  assert.equal(ok, true);
  assert.equal(session.kbLearnHandledAt, 0, 'hard error must not arm the cooldown');
});
