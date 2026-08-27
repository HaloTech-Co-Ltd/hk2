/*-------------------------------------------------------------------------
 *
 * Unit tests for the REPL turn-ui adapter (src/commands/repl_ui.js) — the
 * "REPL unchanged" guard. makeReplUi must reproduce the historical
 * ProgressIndicator / phase / menu mechanics that lived inline in
 * interactive.js before the extraction:
 *
 *   - canPrompt mirrors the old `!!(session.rl && session.rl.terminal)` gate
 *   - spinnerStart/phase drive ProgressIndicator AND session.phase together;
 *     phase() is idempotent (guarded nextPhase)
 *   - phaseOnly updates the session without resurrecting a stopped spinner
 *   - optionList prints header + option rows verbatim and resolves the
 *     0-based index through the consumeNext mechanics; null on cancel
 *   - freeText resolves {text, cancelled}
 *   - onInterrupt degrades to a no-op unsubscribe without a readline
 *
 * Run:  node --test test/repl_ui.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import { createSession } from '../src/commands/session_ctx.js';
import { makeReplUi } from '../src/commands/repl_ui.js';

/* ----- helpers ------------------------------------------------------- */

/** Capture everything written to process.stderr during fn. */
async function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(typeof c === 'string' ? c : c.toString()); return true; };
  try {
    return { out: await fn(), chunks };
  } finally {
    process.stderr.write = orig;
  }
}

/** Bare fake rl: consumeNext mechanics without a real readline. */
function fakeRl() {
  return { terminal: true, closed: false, once() {}, off() {}, input: null };
}

/* ----- tests ---------------------------------------------------------- */

test('canPrompt: false without rl, true with a terminal rl', () => {
  assert.equal(makeReplUi(createSession(null)).canPrompt, false);
  const s = createSession(null);
  s.rl = fakeRl();
  assert.equal(makeReplUi(s).canPrompt, true);
});

test('spinnerStart/phase: drive ProgressIndicator and session.phase together', () => {
  const session = createSession(null);
  const ui = makeReplUi(session);
  ui.spinnerStart('rewriting query');
  assert.equal(ui.progress.phase, 'rewriting query');
  assert.equal(session.phase, 'rewriting query');

  ui.phase('retrieving KB');
  assert.equal(ui.progress.phase, 'retrieving KB');
  assert.equal(session.phase, 'retrieving KB');
});

test('phase(): idempotent — a repeated phase does not re-fire nextPhase', async () => {
  const session = createSession(null);
  const ui = makeReplUi(session);
  await captureStderr(async () => {
    ui.spinnerStart('retrieving KB');
    ui.phase('retrieving KB'); // guard: progress.phase already matches
  });
  assert.equal(ui.progress.phase, 'retrieving KB');
  assert.equal(session.phase, 'retrieving KB');
});

test('phaseOnly(): session phase moves, spinner phase untouched', () => {
  const session = createSession(null);
  const ui = makeReplUi(session);
  ui.spinnerStart('waiting for model');
  ui.progress.stop(); // tool round began — spinner down (historical behavior)
  ui.phaseOnly('tool: bash');
  assert.equal(session.phase, 'tool: bash');
  assert.equal(ui.progress.phase, null, 'stopped spinner stays down');
  assert.equal(ui.progress.stopped, true);
});

test('optionList: prints rows verbatim, resolves 0-based index via consumeNext', async () => {
  const session = createSession(null);
  session.rl = fakeRl();
  const ui = makeReplUi(session);
  const promise = captureStderr(async () => {
    const p = ui.optionList({
      header: ['', 'Pick one:'],
      options: [
        { row: '  1. first choice' },
        { row: '  2. second choice', note: '     the note' },
      ],
    });
    // The prompt registered a consumeNext handler; answer "2".
    await new Promise(r => setImmediate(r));
    session.consumeNext('2');
    return p;
  });
  const { out, chunks } = await promise;
  const all = chunks.join('');
  assert.ok(all.includes('Pick one:'), 'header printed');
  assert.ok(all.includes('  1. first choice'), 'option row printed verbatim');
  assert.ok(all.includes('     the note'), 'note printed');
  assert.ok(all.includes('Choose [1-2]'), 'choice prompt shown');
  assert.deepEqual(out, { index: 1 }, 'second option -> 0-based index 1');
});

test('optionList: resolves null when the rl closes (cancel path)', async () => {
  const session = createSession(null);
  session.rl = fakeRl();
  const ui = makeReplUi(session);
  // promptChoice registers onClose via rl.once; simulate the close.
  const handlers = {};
  session.rl.once = (ev, cb) => { handlers[ev] = cb; };
  const p = captureStderr(async () => {
    const promise = ui.optionList({ header: [], options: [{ row: '  1. only' }] });
    await new Promise(r => setImmediate(r));
    handlers.close();
    return promise;
  });
  const { out } = await p;
  assert.equal(out, null, 'cancel resolves null');
});

test('freeText: resolves trimmed text via consumeNext', async () => {
  const session = createSession(null);
  session.rl = fakeRl();
  const ui = makeReplUi(session);
  const out = await captureStderr(async () => {
    const p = ui.freeText('  Your approach: ');
    await new Promise(r => setImmediate(r));
    session.consumeNext('  do it well  ');
    return p;
  });
  assert.deepEqual(out.out, { text: 'do it well', cancelled: false });
  assert.ok(out.chunks.join('').includes('Your approach:'), 'label printed');
});

test('onInterrupt: no-op unsubscribe without a readline input', () => {
  const session = createSession(null); // no rl at all
  const ui = makeReplUi(session);
  const off = ui.onInterrupt(() => { throw new Error('must not fire'); });
  assert.equal(typeof off, 'function');
  off(); // must not throw
});

test('notice/noticeLines/usageLine: write lines verbatim to stderr', async () => {
  const session = createSession(null);
  const ui = makeReplUi(session);
  const { chunks } = await captureStderr(async () => {
    ui.notice('one');
    ui.noticeLines(['\ntwo', 'three']);
    ui.usageLine('✓ usage line');
    return null;
  });
  const all = chunks.join('');
  assert.ok(all.includes('one\n'));
  assert.ok(all.includes('\ntwo\n'));
  assert.ok(all.includes('three\n'));
  assert.ok(all.includes('✓ usage line\n'));
});
