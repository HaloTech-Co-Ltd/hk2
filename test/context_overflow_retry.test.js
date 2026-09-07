/*-------------------------------------------------------------------------
 *
 * Tests for the context-overflow recovery path:
 *
 *   isContextTooLongError      — recognizes provider "prompt too long"
 *                                rejections and rejects everything else
 *   compactForContextOverflow  — mid-task compaction: folds older turns into
 *                                one summary, keeps the tail verbatim WITH its
 *                                tool_use/tool_result pairing, appends the
 *                                resume-instruction system message, refreshes
 *                                token accounting; respects the env gate
 *   runTurn overflow re-run    — an LLM that fails with the Anthropic 1261
 *                                shape once and succeeds on the re-run
 *                                completes the turn instead of dying; a turn
 *                                that keeps failing past the recovery budget
 *                                surfaces the original error
 *
 * Run:  node --test test/context_overflow_retry.test.js
 *-----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  isContextTooLongError,
  compactForContextOverflow,
  compactMessages,
} = await import('../src/commands/turn_support.js');
const { runTurn } = await import('../src/commands/turn.js');
const { createSession, buildCtx } = await import('../src/commands/interactive.js');
const { buildBaseCtx } = await import('../src/commands/session_ctx.js');

/* ── isContextTooLongError ───────────────────────────────────────────── */

test('isContextTooLongError matches the reported Anthropic 1261 shape', () => {
  const err = new Error('Anthropic 400: {"type":"error","error":{"type":"invalid_request_error","code":"1261","message":"[1261][prompt is too long][202609052242374e85f16e9cf044dc]"},"request_id":"20260905224237485f16e9cf044dc"}');
  assert.equal(isContextTooLongError(err), true);
});

test('isContextTooLongError matches other provider phrasings', () => {
  assert.equal(isContextTooLongError(new Error('OpenAI 400: this model\'s maximum context length is 8192 tokens. However, your messages resulted in 12000 tokens')), true);
  assert.equal(isContextTooLongError(new Error('context_length_exceeded')), true);
  assert.equal(isContextTooLongError(new Error('400: input is too long')), true);
  assert.equal(isContextTooLongError(new Error('413 Request Entity Too Large')), true);
});

test('isContextTooLongError rejects non-overflow errors', () => {
  assert.equal(isContextTooLongError(new Error('Anthropic 401: invalid x-api-key')), false);
  assert.equal(isContextTooLongError(new Error('Anthropic 404: model not found')), false);
  assert.equal(isContextTooLongError(new Error('Anthropic 502: bad gateway (nginx)')), false);
  assert.equal(isContextTooLongError(new Error('aborted')), false);
  assert.equal(isContextTooLongError(new Error('LLM baseUrl not configured')), false);
  assert.equal(isContextTooLongError(null), false);
  assert.equal(isContextTooLongError(new Error('')), false);
});

/* ── compactForContextOverflow ───────────────────────────────────────── */

// A fake LLM whose summarize path succeeds (complete returns a fixed summary).
// compactMessages -> summarizeConversation uses llm.stream per turn_support's
// import of lib/llm/client.js — actually summarizeConversation uses llm.complete.
// Provide both so any code path works.
function summarizingLlm() {
  const summary = 'COMPACT-SUMMARY: user asked to refactor, two files were edited, tests pending.';
  return {
    complete: async () => summary,
    stream: async function* () {
      yield { type: 'delta', text: summary };
    },
  };
}

function overflowableSession() {
  const session = createSession();
  session.llm = summarizingLlm();
  session.modelCfg = { ...session.modelCfg, maxChars: 8192 };
  // 8 user/assistant turns (> 6 so compaction applies) with tool traffic in
  // the tail that MUST survive with its pairing intact.
  session.messages = [
    { role: 'system', content: 'MAIN SYSTEM PROMPT' },
    { role: 'user', content: 'u1 old' },
    { role: 'assistant', content: 'a1 old' },
    { role: 'user', content: 'u2 old' },
    { role: 'assistant', content: 'a2 old' },
    { role: 'user', content: 'u3 kept' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_9', name: 'bash', content: '{"ok":true}' },
    { role: 'assistant', content: 'a3 kept with tool result above' },
    { role: 'user', content: 'u4 kept' },
  ];
  session.lastTask = { userRequest: 'refactor the module', capturedAt: '2026-01-01T00:00:00Z' };
  return session;
}

test('compactForContextOverflow compacts, preserves pairing, and injects a resume message', async () => {
  const session = overflowableSession();
  const prints = [];
  const ctx = { ...buildCtx(session), print: (t) => prints.push(t) };

  const out = await compactForContextOverflow(session, ctx);

  assert.equal(out.compacted, true);
  const msgs = session.messages;

  // 1. One compacted summary block exists, folding the old turns.
  const summary = msgs.filter(m => m.role === 'system' && String(m.content).startsWith('## Prior conversation (compacted)'));
  assert.equal(summary.length, 1, 'exactly one compacted-summary system message');
  assert.ok(String(summary[0].content).includes('COMPACT-SUMMARY'), 'summary text came from the LLM summarizer');

  // 2. Main system prompt survives verbatim.
  assert.ok(msgs.some(m => m.role === 'system' && m.content === 'MAIN SYSTEM PROMPT'));

  // 3. Kept tail is verbatim and its tool pairing is intact.
  assert.ok(msgs.some(m => m.role === 'user' && m.content === 'u4 kept'));
  assert.ok(msgs.some(m => m.role === 'assistant' && m.content === 'a3 kept with tool result above'));
  const toolMsg = msgs.find(m => m.role === 'tool');
  assert.ok(toolMsg && toolMsg.tool_call_id === 'call_9', 'paired tool result kept');
  const asstIdx = msgs.findIndex(m => Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc.id === 'call_9'));
  const toolIdx = msgs.indexOf(toolMsg);
  assert.ok(asstIdx >= 0 && toolIdx === asstIdx + 1, 'tool result immediately follows its tool_use');

  // 4. Resume instruction is the LAST message (injected after the tail).
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'system');
  assert.match(String(last.content), /context-length limit/);
  assert.match(String(last.content), /refactor the module/);
  assert.match(String(last.content), /Continue the in-flight work|CONTINUE the interrupted task/);

  // 5. Accounting + user notice.
  assert.ok(session.lastContextTokens > 0, 'token estimate refreshed');
  assert.ok(prints.some(t => String(t).includes('[auto-compact]')), 'user-visible notice printed');
});

test('compactForContextOverflow is a no-op when auto-compact is disabled', async () => {
  const prev = process.env.HK2_ENABLE_AUTOCOMPACT;
  process.env.HK2_ENABLE_AUTOCOMPACT = '0';
  try {
    const session = overflowableSession();
    const before = session.messages.length;
    const out = await compactForContextOverflow(session, buildCtx(session));
    assert.equal(out.compacted, false);
    assert.match(out.reason, /disabled/);
    assert.equal(session.messages.length, before);
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_AUTOCOMPACT;
    else process.env.HK2_ENABLE_AUTOCOMPACT = prev;
  }
});

test('compactForContextOverflow reports failure when there is too little to compact', async () => {
  const session = createSession();
  session.llm = summarizingLlm();
  session.messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const out = await compactForContextOverflow(session, buildCtx(session));
  assert.equal(out.compacted, false);
  assert.match(out.reason, /not enough/);
});

/* ── runTurn end-to-end (mocked LLM + ui) ────────────────────────────── */

// A minimal KB runtime stub: enough for runTurn's gates (session.rt truthy)
// and for buildTools' KB tool registration (list()/lookup() empty).
function rtStub() {
  return {
    kb: {
      list: async () => ({ tools: [] }),
      lookup: async () => null,
    },
  };
}

function makeUi() {
  const calls = { notices: [], phases: [], failed: [], interrupted: 0, finishes: 0 };
  return {
    calls,
    canPrompt: false,
    stream: {
      reset() {}, delta() {}, reasoning() {}, flushReasoning() {},
      flushMarkdown() {}, flush() {},
    },
    progress: {
      phase: null, stopped: false, midLine: false,
      start(p) { this.phase = p; }, nextPhase(p) { this.phase = p; },
      reason() { this.phase = 'thinking'; }, resume(p) { this.phase = p; this.stopped = false; },
      pause() { this.phase = null; }, stop() { this.phase = null; this.stopped = true; },
      tick() { this.stopped = true; }, done() { this.phase = null; }, breakLine() {},
    },
    phase(p) { calls.phases.push(p); },
    phaseOnly() {}, setPhaseSafe() {},
    spinnerStart(p) { calls.phases.push(p); },
    statusRefresh() {},
    toolStart() {}, toolEnd() {},
    finishStream() { calls.finishes++; },
    notice(t) { calls.notices.push(String(t)); },
    noticeLines() {},
    retryNotice() {},
    userEcho() {}, usageLine() {},
    cancelled() {}, interrupted() { calls.interrupted++; },
    failed(err) { calls.failed.push(String(err?.message || err)); },
    confirm: async () => true,
    optionList: async () => 1,
    freeText: async () => '',
    onInterrupt() { return () => {}; },
  };
}

// Real project + real (tiny) KB index in a temp dir, so the KB gate passes
// and buildTools registers normally. Registered projects are removed after.
async function makeKbSession(llm, messages, lastTask) {
  const home = await import('../lib/config/home.js');
  const { addKbForProject } = await import('../lib/index/registry.js');
  const { buildIndex } = await import('../lib/index/indexer.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-overflow-'));
  await fs.writeFile(path.join(dir, 'one.js'), 'export function alpha() { return 1; }\n');
  const p = await home.registerProject({ sourcePath: dir, name: `overflow-t-${Date.now()}` });
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });
  const session = createSession(p.id);
  session.project = p;
  session.rt = { ...rtStub() };
  session.kbMeta = {};
  session.llm = llm;
  session.modelCfg = { ref: 'p/m', maxChars: 8192, enableReasoning: false, temperature: 0.2 };
  session.messages = messages;
  session.lastTask = lastTask;
  const prevCur = await home.getCurrentProject().catch(() => null);
  await home.setCurrentProject(p.id).catch(() => {});
  const cleanup = async () => {
    try {
      if (prevCur?.id) await home.setCurrentProject(prevCur.id).catch(() => {});
    } finally {
      await home.removeProject(p.id).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
  return { session, cleanup };
}

// Quiet the pre-agent phases so the fake ui suffices (same convention as
// tui_review3.test.js). NOTE: these flags DEFAULT TO 1, so they must be
// explicitly set to '0' — deleting them would leave the phases ENABLED and
// the rewrite phase would add an extra llm.stream call to every count.
// HK2_ENABLE_AUTOCOMPACT stays at its default (on): the recovery path
// depends on it.
function quietPrePhases() {
  const saved = {};
  for (const k of ['HK2_ENABLE_QUERYREWRITE', 'HK2_ENABLE_REQUEST_ASSESS']) {
    saved[k] = process.env[k];
    process.env[k] = '0';
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

// LLM that rejects the FIRST stream() with the exact Anthropic 1261 error,
// then succeeds with a plain-text answer.
function overflowThenSuccessLlm() {
  let calls = 0;
  return {
    get callCount() { return calls; },
    stream: async function* () {
      calls++;
      if (calls === 1) {
        throw new Error('Anthropic 400: {"type":"error","error":{"type":"invalid_request_error","code":"1261","message":"[1261][prompt is too long][202609052242374e85f16e9cf044dc]"},"request_id":"20260905224237485f16e9cf044dc"}');
      }
      yield { type: 'delta', text: 'Task resumed and completed after compaction.' };
    },
    complete: async () => 'SUMMARY',
  };
}

test('runTurn recovers from a context-overflow error and finishes the task', async () => {
  const llm = overflowThenSuccessLlm();
  const base = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },
    { role: 'assistant', content: 'a4' },
  ];
  const { session, cleanup } = await makeKbSession(llm, base, { userRequest: 'do the thing', capturedAt: '2026-01-01T00:00:00Z' });
  const restore = quietPrePhases();
  try {
  const ui = makeUi();
    const prints = [];
    const ctx = { ...buildCtx(session), print: (t) => prints.push(String(t)) };

  await runTurn('continue the work', session, ctx, ui);

  // The turn must NOT have failed...
  assert.equal(ui.calls.failed.length, 0, `expected no failure, got: ${ui.calls.failed[0]}`);
  assert.equal(ui.calls.interrupted, 0);
  // ...the LLM was called twice (fail → recover → succeed)...
    assert.equal(llm.callCount, 2, 'LLM re-issued after compaction');
  // ...a resume instruction was injected into the compacted history...
  const resume = session.messages.filter(m => m.role === 'system' && String(m.content).includes('context-length limit'));
  assert.equal(resume.length, 1, 'exactly one resume instruction');
    // ...the final answer came through.
  assert.equal(session.lastAnswer, 'Task resumed and completed after compaction.');
    assert.ok(prints.some(t => t.includes('[auto-compact]')), 'user saw the compaction notice');
  } finally {
    restore();
    await cleanup();
  }
});

test('runTurn surfaces the original error when overflow persists past the recovery budget', async () => {
  const err = new Error('Anthropic 400: {"type":"error","error":{"type":"invalid_request_error","code":"1261","message":"[1261][prompt is too long]"},"request_id":"x"}');
  let calls = 0;
  const llm = {
    stream: async function* () { calls++; throw err; },
    complete: async () => 'SUMMARY',
  };
  const base = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },
    { role: 'assistant', content: 'a4' },
  ];
  const { session, cleanup } = await makeKbSession(llm, base, { userRequest: 'keep going task', capturedAt: '2026-01-01T00:00:00Z' });
  const restore = quietPrePhases();
  try {
    const ui = makeUi();
    const ctx = buildCtx(session);

    await runTurn('keep going', session, ctx, ui);

    assert.equal(ui.calls.failed.length, 1, 'turn failed with the original error');
    assert.match(ui.calls.failed[0], /prompt is too long/);
    // Cycle protection: initial attempt + one recovery re-run. The second
    // recovery finds nothing left to compact (post-compaction conversation is
    // below compactMessages' 6-message floor) → compacted:false → the ORIGINAL
    // error surfaces instead of looping compact→400→compact forever.
    assert.equal(calls, 2, 'no infinite recovery loop');
  } finally {
    restore();
    await cleanup();
  }
});

test('non-overflow LLM errors are not diverted into compaction', async () => {
  const err = new Error('Anthropic 401: invalid x-api-key');
  let calls = 0;
  const llm = {
    stream: async function* () { calls++; throw err; },
    complete: async () => 'SUMMARY',
  };
  const base = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },
    { role: 'assistant', content: 'a4' },
  ];
  const { session, cleanup } = await makeKbSession(llm, base, null);
  const restore = quietPrePhases();
  try {
    const ui = makeUi();
    const prints = [];
    const ctx = { ...buildCtx(session), print: (t) => prints.push(String(t)) };
    const before = session.messages.slice();

    await runTurn('hello', session, ctx, ui);

    // Original error reaches ui.failed verbatim...
    assert.equal(ui.calls.failed.length, 1);
    assert.match(ui.calls.failed[0], /401/);
    // ...no re-run was attempted (non-overflow errors never enter recovery)...
    assert.equal(calls, 1, 'no re-run for non-overflow errors');
    // ...no resume system message was injected...
    assert.equal(session.messages.filter(m => m.role === 'system' && String(m.content).includes('context-length limit')).length, 0,
      'no resume message injected');
    // ...no compaction summary block appeared...
    assert.equal(session.messages.filter(m => m.role === 'system' && String(m.content).startsWith('## Prior conversation (compacted)')).length, 0,
      'conversation was not compacted');
    // ...the user saw no [auto-compact] notice...
    assert.ok(!prints.some(t => t.includes('[auto-compact]')), 'no compaction notice printed');
    // ...and the message list only grew by the user turn itself (system
    // prompt may be rebuilt at the head; the pre-existing history is intact).
    const pre = new Set(before);
    const originalsKept = before.every(m => pre.has(m) && session.messages.includes(m));
    assert.ok(originalsKept, 'no pre-existing message was removed or replaced by compaction');
    assert.equal(session.messages.filter(m => m.role === 'user').length, before.filter(m => m.role === 'user').length + 1,
      'exactly one user message added (the turn input)');
  } finally {
    restore();
    await cleanup();
  }
});
