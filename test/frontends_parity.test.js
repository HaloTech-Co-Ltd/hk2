/*-------------------------------------------------------------------------
 *
 * FRONT-END PARITY regression: the line REPL and the inline TUI must answer
 * the SAME scripted interaction with the SAME semantics. Two layers:
 *
 *   io layer  — replIo (readline consumeNext) vs makeTuiIo (ModalHost):
 *              confirm / confirmThreeWay / choose / write all resolve
 *              identically for the same user answers.
 *   ui layer  — makeReplUi vs makeTuiUi replayed with the same event script:
 *              answers, tool lines, retry notices, interrupt/failure notices
 *              carry the same content (rendering mechanics may differ).
 * Plus the SIGINT/Ctrl+C contract: mid-turn = interrupt on BOTH front-ends.
 *
 * Run:  node --test test/frontends_parity.test.js
 *----------------------------------------------------------------------*/
import './_tty_env.js';
import './_learn_setup.js';

import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert';
import { createSession } from '../src/commands/session_ctx.js';
import { replIo } from '../src/commands/session_ctx.js';
import { makeTuiIo } from '../src/tui/tui_io.js';
import { ModalHost } from '../src/tui/modal.js';
import { makeReplUi } from '../src/commands/repl_ui.js';
import { makeTuiUi } from '../src/tui/tui_ui.js';

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/* ------------------------------------------------------------------ */
/* io layer: identical contracts                                        */
/* ------------------------------------------------------------------ */

/** Fake readline session good enough for replIo's consumeNext mechanics. */
function fakeRlSession() {
  const session = createSession(null);
  session.rl = { closed: false, line: '', cursor: 0, once() {}, off() {}, on() {} };
  return session;
}

/** Answer the pending replIo prompt with `text` (the user's keystrokes). */
function answer(session, text) {
  const cb = session.consumeNext;
  session.consumeNext = null;
  cb(text);
}

async function replConfirm(input, threeWay = false) {
  const session = fakeRlSession();
  const io = replIo(session);
  const captured = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { captured.push(s); return true; };
  try {
    const p = threeWay ? io.confirmThreeWay('Q?') : io.confirm('Q?');
    await Promise.resolve();          // let the prompt arm consumeNext
    answer(session, input);
    return await p;
  } finally {
    process.stderr.write = orig;
  }
}

async function tuiConfirm(keySeq, threeWay = false) {
  const host = new ModalHost();
  const io = makeTuiIo({ writeLine: () => {}, write: () => {} }, host, {});
  const p = threeWay ? io.confirmThreeWay('Q?') : io.confirm('Q?');
  await Promise.resolve();
  for (const k of keySeq) host.applyKey(k);
  return await p;
}

test('io parity: confirm — y/n/Esc resolve identically on both front-ends', async () => {
  assert.equal(await replConfirm('y'), true);
  assert.equal(await tuiConfirm([{ type: 'char', text: 'y' }]), true);
  assert.equal(await replConfirm('n'), false);
  assert.equal(await tuiConfirm([{ type: 'char', text: 'n' }]), false);
  // Cancel: replIo has no Esc path (Ctrl+D / close → false); the TUI's Esc
  // and Ctrl+D both → false. Same conservative outcome.
  assert.equal(await tuiConfirm([{ type: 'escape' }]), false);
  assert.equal(await tuiConfirm([{ type: 'ctrl', ch: 'd' }]), false);
});

test('io parity: three-way confirm — e routes to eden on both', async () => {
  assert.equal(await replConfirm('e', true), 'eden');
  assert.equal(await tuiConfirm([{ type: 'char', text: 'e' }], true), 'eden');
  assert.equal(await replConfirm('y', true), true);
  assert.equal(await tuiConfirm([{ type: 'up' }, { type: 'enter' }], true), true);
});

test('io parity: choose — numeric pick and cancel-to-conservative match', async () => {
  const opts = ['first', 'second', 'third'];
  // replIo: '2' → 2
  {
    const session = fakeRlSession();
    const io = replIo(session);
    const p = io.choose('Pick:', opts);
    await Promise.resolve();
    answer(session, '2');
    assert.equal(await p, 2);
  }
  // tuiIo: char '2' → 2; number-jump key same
  assert.equal(await (async () => {
    const host = new ModalHost();
    const io = makeTuiIo({ writeLine: () => {} }, host, {});
    const p = io.choose('Pick:', opts);
    await Promise.resolve();
    host.applyKey({ type: 'char', text: '2' });
    return await p;
  })(), 2);
  // Cancel: replIo Ctrl+D/closed → n (last, conservative); TUI Esc → n.
  {
    const session = fakeRlSession();
    const io = replIo(session);
    const p = io.choose('Pick:', opts);
    await Promise.resolve();
    answer(session, '');            // empty Enter → default = last
    assert.equal(await p, 3);
  }
  assert.equal(await (async () => {
    const host = new ModalHost();
    const io = makeTuiIo({ writeLine: () => {} }, host, {});
    const p = io.choose('Pick:', opts);
    await Promise.resolve();
    host.applyKey({ type: 'escape' });
    return await p;
  })(), 3);
});

/* ------------------------------------------------------------------ */
/* ui layer: same event script, same visible content                    */
/* ------------------------------------------------------------------ */

function replayEvents(ui, S) {
  ui.stream.reset();
  ui.stream.delta('Hello ');
  ui.stream.delta('world');
  ui.stream.flushReasoning();
  ui.stream.flushMarkdown();
  ui.toolStart({ name: 'kb_search', id: 'c1' }, { query: 'tokenize' });
  ui.toolEnd({ name: 'kb_search', id: 'c1' }, { ok: true, result: { hits: [] } });
  ui.finishStream();
  ui.retryNotice({ attempt: 1, maxRetries: 10, delayMs: 2000, error: 'HTTP 429' });
  ui.usageLine(S.usageText);
  ui.interrupted();
  ui.failed(new Error('boom from provider'));
}

test('ui parity: the same turn-event script renders the same CONTENT on both front-ends', async () => {
  // REPL: capture everything its writers push (stdout + stderr).
  const replOut = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (s) => { replOut.push(s); return true; };
  process.stderr.write = (s) => { replOut.push(s); return true; };
  let replUi;
  try {
    const rs = createSession(null);
    rs.rl = { terminal: false };           // onInterrupt stays unwired (headless)
    rs.statusBar = { update() {} };
    replUi = makeReplUi(rs);
    replayEvents(replUi, { usageText: '✓ usage · ↑1 ↓2' });
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }

  // TUI: capture through a fake Frame.
  const tuiOut = [];
  const frame = {
    write: (s) => tuiOut.push(s),
    writeLine: (s = '') => tuiOut.push(s + '\n'),
    requestRender: () => {},
  };
  const ts = createSession(null);
  const tuiUi = makeTuiUi(frame, ts, new ModalHost(), {});
  replayEvents(tuiUi, { usageText: '✓ usage · ↑1 ↓2' });

  const replText = strip(replOut.join(''));
  const tuiText = strip(tuiOut.join(''));

  // Content both front-ends MUST carry for the same events.
  for (const needle of [
    'Hello world',                       // streamed answer
    '[llm retry 1/10 in 2s: HTTP 429]',  // retry notice (same words)
    '✓ usage · ↑1 ↓2',                   // usage line (TUI appends duration — allowed)
    'interrupted — partial output preserved',
    'Error: boom from provider',
  ]) {
    assert.ok(replText.includes(strip(needle)), `REPL renders ${JSON.stringify(needle)}`);
    assert.ok(tuiText.includes(strip(needle)), `TUI renders ${JSON.stringify(needle)}`);
  }
  // Tool identity: each front-end in its own vocabulary — the REPL card
  // titles the raw tool id, the TUI compact line maps it to a display name
  // (kb_search → KB Search) with the same argument payload.
  assert.ok(replText.includes('kb_search') && replText.includes('tokenize'),
    'REPL card: raw tool id + argument');
  assert.ok(tuiText.includes('KB Search(tokenize)'),
    'TUI compact line: display name + same argument');
});

/* ------------------------------------------------------------------ */
/* interrupt contract parity                                            */
/* ------------------------------------------------------------------ */

test('Ctrl+C contract: BOTH front-ends interrupt the turn instead of hard-exiting', async () => {
  // repl_ui publishes the turn's trigger for the SIGINT handler…
  const { onInterrupt } = makeReplUi((() => {
    const s = createSession(null);
    s.rl = { input: new EventEmitter(), terminal: true };
    return s;
  })());
  let fired = 0;
  const off = onInterrupt(() => fired++);
  const session = createSession(null);
  const srcInteractive = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/commands/interactive.js', import.meta.url), 'utf8'));
  assert.ok(srcInteractive.includes('session._turnInterrupt();'),
    'the REPL SIGINT handler routes mid-turn Ctrl+C through the turn abort');
  assert.ok(srcInteractive.includes("session.rl.on('SIGINT', () => {});"),
    'readline is kept from auto-closing on Ctrl+C (interface survives the interrupt)');
  off();

  // …and the TUI key loop maps Ctrl+C-during-turn to the same fireInterrupt.
  const srcTui = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tui/index.js', import.meta.url), 'utf8'));
  assert.ok(/if \(session\.agentTurnActive\)[\s\S]{0,120}fireInterrupt\(\)/.test(srcTui),
    'TUI Ctrl+C during a turn fires the interrupt');
});
