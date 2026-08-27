/*-------------------------------------------------------------------------
 *
 * Unit tests for the extracted turn pipeline (src/commands/turn.js) driven
 * through a RECORDING fake ui — pins the ui event sequence runTurn must
 * produce, independent of any concrete front-end (REPL or TUI).
 *
 * Covered:
 *   - happy path: phase order (retrieving KB → waiting for model → idle),
 *     stream lifecycle (reset per LLM call, delta → assistantText/lastAnswer,
 *     finishStream), token accounting, context snapshot in finally
 *   - failure path: ui.failed + session.phase='error', no crash without a
 *     project, disarm of the mid-task capture on early exit
 *
 * Run:  node --test test/turn_ui.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { createSession, buildCtx } from '../src/commands/session_ctx.js';
import { runTurn } from '../src/commands/turn.js';

/* ----- helpers ------------------------------------------------------- */

/** Recording fake ui: every method appends to `events`; no I/O. */
function fakeUi() {
  const events = [];
  const rec = (name) => (...args) => { events.push([name, ...args]); };
  return {
    events,
    canPrompt: false, // disables the assess phase (no clarification round)
    progress: {
      phase: null, stopped: false, midLine: false,
      start(p) { this.phase = p; events.push(['progress.start', p]); },
      nextPhase(p) { this.phase = p; events.push(['progress.nextPhase', p]); },
      reason() { this.phase = 'thinking'; events.push(['progress.reason']); },
      resume(p) { this.phase = p; this.stopped = false; events.push(['progress.resume', p]); },
      pause() { this.phase = null; events.push(['progress.pause']); },
      stop() { this.phase = null; this.stopped = true; events.push(['progress.stop']); },
      tick() { events.push(['progress.tick']); },
      done() { events.push(['progress.done']); },
      breakLine() { events.push(['progress.breakLine']); },
    },
    spinnerStart(p) { rec('spinnerStart')(p); this.progress.start(p); },
    phase(p) {
      if (this.progress.phase !== p) this.progress.nextPhase(p);
      rec('phase')(p);
    },
    phaseOnly(p) { rec('phaseOnly')(p); },
    setPhaseSafe(p) { rec('setPhaseSafe')(p); },
    statusRefresh() { rec('statusRefresh')(); },
    stream: {
      reset() { events.push(['stream.reset']); },
      delta(text) { events.push(['stream.delta', text]); },
      reasoning(text) { events.push(['stream.reasoning', text]); },
      flushReasoning() { events.push(['stream.flushReasoning']); return ''; },
      flushMarkdown() { events.push(['stream.flushMarkdown']); return ''; },
      flush() { events.push(['stream.flush']); return ''; },
    },
    toolStart(call) { rec('toolStart')(call.name); },
    toolEnd(call) { rec('toolEnd')(call.name); },
    finishStream() { rec('finishStream')(); },
    noticeLines(lines) { rec('noticeLines')(lines.length); },
    notice(text) { rec('notice')(text); },
    userEcho(lines) { rec('userEcho')(lines.length); },
    usageLine(text) { rec('usageLine')(text); },
    cancelled() { rec('cancelled')(); },
    interrupted() { rec('interrupted')(); },
    failed(err) { rec('failed')(err.message); },
    confirm: async () => false,
    optionList: async () => null,
    freeText: async () => ({ text: '', cancelled: true }),
    onInterrupt() { return () => {}; },
  };
}

/** Minimal fake LLM: streams the given text chunks, then finishes. */
function fakeLlm({ chunks = ['Hello', ' world'], throwAt } = {}) {
  return {
    async *stream(_messages, opts = {}) {
      for (const c of chunks) {
        if (opts.signal?.aborted) throw new Error('aborted');
        if (throwAt === c) throw new Error('boom from provider');
        yield { type: 'delta', text: c };
      }
      yield { type: 'usage', input: 42, output: 7 };
    },
  };
}

function mkSession(llm) {
  const session = createSession(null);
  session.llm = llm;
  session.modelCfg = { ref: 'test/model', maxChars: 65536, temperature: 0.2, enableReasoning: false };
  session.rt = null; // buildRequestGraph fails -> caught, turn continues without graph
  return session;
}

/* ----- happy path ----------------------------------------------------- */

test('runTurn: phase order, stream lifecycle, answer capture, idle exit', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0'; // skip the rewrite LLM pass
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const session = mkSession(fakeLlm());
    const ctx = buildCtx(session);
    const ui = fakeUi();
    await runTurn('what is up', session, ctx, ui);

    const names = ui.events.map(e => e[0]);
    // Rewrite disabled + no KB (mkSession sets rt=null) -> the turn starts
    // directly on the model wait; retrieval is skipped silently.
    assert.ok(names.includes('spinnerStart'), 'spinner started');
    assert.equal(ui.events.find(e => e[0] === 'spinnerStart')[1], 'waiting for model');
    assert.ok(names.includes('phase'), 'guarded phase transitions recorded');
    // Enter the loop and stream the body.
    assert.equal(ui.events.find(e => e[0] === 'phase' && e[1] === 'waiting for model') !== undefined, true,
      'waiting-for-model phase emitted');
    assert.ok(names.includes('stream.delta'), 'body deltas routed through ui.stream');
    assert.equal(session.lastAnswer, 'Hello world', 'assistant text captured');
    assert.ok(names.includes('finishStream'), 'finishStream closes the render');
    assert.equal(session.phase, 'idle', 'session back to idle');
    assert.equal(session.tokens.callIn, 42, 'usage accounted');
    assert.equal(session.lastContextTokens, 42, 'context snapshot taken in finally');
    // No project on the session: no task state was armed.
    assert.equal(session.agentTurnActive, false, 'mid-task capture disarmed');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});

/* ----- failure path --------------------------------------------------- */

test('runTurn: provider error -> ui.failed, phase=error, capture disarmed', async () => {
  process.env.HK2_ENABLE_QUERYREWRITE = '0';
  process.env.HK2_ENABLE_REQUEST_ASSESS = '0';
  try {
    const session = mkSession(fakeLlm({ chunks: ['partial ', 'KABOOM'], throwAt: 'KABOOM' }));
    const ctx = buildCtx(session);
    const ui = fakeUi();
    await runTurn('doomed request', session, ctx, ui);

    const failed = ui.events.find(e => e[0] === 'failed');
    assert.ok(failed, 'ui.failed called');
    assert.equal(failed[1], 'boom from provider');
    assert.equal(ui.events.some(e => e[0] === 'interrupted'), false, 'not an interrupt');
    assert.equal(session.phase, 'error', 'session marked error');
    assert.equal(session.agentTurnActive, false, 'mid-task capture disarmed on error too');
    assert.ok(ui.events.some(e => e[0] === 'progress.done'), 'spinner finalized');
  } finally {
    delete process.env.HK2_ENABLE_QUERYREWRITE;
    delete process.env.HK2_ENABLE_REQUEST_ASSESS;
  }
});
