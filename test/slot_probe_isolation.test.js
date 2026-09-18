/*-------------------------------------------------------------------------
 *
 * Regression tests for the slot-probe input-isolation round (the
 * "add instruction" R-injection regression, introduced by the first
 * continuation-slot watchdog patch and fixed by lib/agent/slot_probe.js):
 *
 *   1. PROBE SEMANTICS: the probe sequence restores the SAVED DECSC slot
 *      before asking (ESC8 + ESC[6n + ESC7 + park), so the DSR row is the
 *      SLOT's row — a docked input box no longer masquerades as drift
 *      (the old patch asked at the docked cursor, inside the reserved
 *      block, and healed every ~5s: the plan-panel flicker regression).
 *   2. INPUT ISOLATION: while a probe window is open, DSR answers are
 *      consumed and NEVER reach readline's keypress stack — no stray "R"
 *      characters in the mid-task draft (whole, fragmented, and
 *      answer-plus-keystroke interleavings).
 *   3. KEYSTROKE REPLAY: user bytes that share a window with probe traffic
 *      are replayed byte-for-byte when it closes — zero keystrokes lost,
 *      arrow keys still work.
 *   4. TIMEOUT: a silent terminal heals conservatively and the window
 *      still closes (listeners re-attached, keystrokes replayed).
 *   5. CLEANUP: the uninstall removes the probe seam entirely.
 *
 * Run:  node --test test/slot_probe_isolation.test.js
 *------------------------------------------------------------------------*/
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StatusBar } from '../lib/agent/statusbar.js';
import { installSlotProbe } from '../lib/agent/slot_probe.js';

function makeRig({ rows = 24, cols = 80, input = () => ['> box'], plan = () => [], dockCol = 5 } = {}) {
  const writes = [];
  const fakeStream = new Writable({ write(chunk, _enc, cb) { writes.push(chunk.toString()); cb(); } });
  fakeStream.isTTY = true;
  fakeStream.columns = cols;
  fakeStream.rows = rows;
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: rows, configurable: true });
  const bar = new StatusBar(fakeStream, {
    formatter: () => 'STATUS',
    planRenderer: plan,
    inputRenderer: input,
  });
  bar.setInputCursorFn(() => dockCol);
  bar.start();
  bar.update(); // paint once; input row reserved

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const rl = readline.createInterface({ input: stdin, output: fakeStream, terminal: true, prompt: 'P> ' });
  rl.prompt();

  const cleanup = installSlotProbe(stdin, bar);
  return { bar, rl, stdin, writes, cleanup };
}

/** Geometry of the rig: 24 rows, empty plan, 1 input row, 1 status row
 *  → scroll workspace = rows 1..22, reserved block = rows 23..24,
 *  re-bank target (workspace bottom) = row 22, dock park = row 23 col 5. */
const HEAL_ROW = '22;1H';

/** Drive one probe synchronously to its verdict by injecting a DSR answer. */
function probeWith(bar, stdin, answer) {
  bar._slotProbeFn?.();
  if (answer !== undefined) stdin.write(answer);
}

test('probe sequence restores the SAVED slot before asking (not the docked cursor)', () => {
  const { bar, stdin, writes, cleanup } = makeRig();
  const before = writes.length;
  probeWith(bar, stdin);
  const seq = writes.slice(before).join('');
  // ESC8 (restore slot) must PRECEDE ESC[6n (ask); ESC7 re-saves; park re-docks.
  const ask = seq.indexOf('\x1b[6n');
  const restore = seq.indexOf('\x1b8');
  assert.ok(ask >= 0, 'probe emitted a DSR ask');
  assert.ok(restore >= 0 && restore < ask, `DECRC must precede the DSR ask, got: ${JSON.stringify(seq.slice(0, 40))}`);
  assert.ok(seq.includes('\x1b8\x1b[6n\x1b7'), 'ask is bracketed by slot restore/re-save');
  // Silent-terminal path never ran: the answer below arrives in-window.
  stdin.write('\x1b[10;1R'); // slot row 10 = inside the workspace (scrollBottom 22)
  cleanup();
});

test('healthy slot verdict: no heal write after the probe', () => {
  const { bar, stdin, writes, cleanup } = makeRig();
  bar.update();
  const before = writes.length;
  probeWith(bar, stdin, '\x1b[10;1R');
  const after = writes.slice(before).join('');
  assert.ok(!after.includes(`${HEAL_ROW}\x1b7`), `healthy slot must NOT heal, tail: ${JSON.stringify(after.slice(-60))}`);
  cleanup();
});

test('drift verdict: slot row inside the reserved block heals (re-banks + re-docks)', () => {
  const { bar, stdin, writes, cleanup } = makeRig();
  bar.update();
  const before = writes.length;
  probeWith(bar, stdin, '\x1b[24;1R'); // status row = reserved block
  const after = writes.slice(before).join('');
  assert.ok(after.includes(HEAL_ROW), `drift must re-bank at the workspace bottom (22), tail: ${JSON.stringify(after.slice(-80))}`);
  assert.ok(after.includes(';5H'), 'heal re-docks the cursor into the box');
  cleanup();
});

test('INPUT ISOLATION: a whole DSR answer never reaches readline (no stray R in the draft)', () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  stdin.write('add inst');            // the user is typing an instruction
  assert.equal(rl.line, 'add inst');
  const keypsBefore = [];
  const onKp = (s, k) => { keypsBefore.push(k?.name ?? k?.sequence); };
  stdin.on('keypress', onKp);
  probeWith(bar, stdin, '\x1b[24;1R'); // probe + answer in-window
  assert.equal(rl.line, 'add inst', 'draft untouched by the DSR answer');
  assert.ok(!keypsBefore.some((k) => k === 'R' || String(k).includes('24;1R')),
    `no probe bytes emitted as keypresses, got: ${JSON.stringify(keypsBefore)}`);
  stdin.off('keypress', onKp);
  stdin.write('ruction');             // typing still works afterwards
  assert.equal(rl.line, 'add instruction', 'readline editing intact after the window');
  cleanup();
});

test('INPUT ISOLATION: fragmented answer (ESC[ | r;cR) also stays out of the draft', () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  stdin.write('note');
  probeWith(bar, stdin);
  stdin.write('\x1b[');       // fragment 1
  stdin.write('21;5R');       // fragment 2 completes the answer (healthy row)
  assert.equal(rl.line, 'note', 'fragmented answer never leaked into the draft');
  cleanup();
});

test('KEYSTROKE REPLAY: user bytes sharing a window chunk are replayed, not eaten', () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  stdin.write('type');
  assert.equal(rl.line, 'type');
  probeWith(bar, stdin);
  // One chunk: an arrow-left + 'X' BEFORE the answer bytes.
  stdin.write('\x1b[DX\x1b[10;1R');
  // Window closes on the answer; the replay must deliver left + X in order.
  assert.equal(rl.line, 'typXe', `keystrokes replayed in order (left + X at cursor), got: ${JSON.stringify(rl.line)}`);
  assert.equal(rl.cursor, 4);
  cleanup();
});

test('KEYSTROKE REPLAY: a bare trailing ESC is held back (may open an answer), plain keys are not', async () => {
  const { bar, rl, stdin, writes, cleanup } = makeRig();
  const before = writes.length;
  probeWith(bar, stdin);
  // No answer comes — plain keys typed during the window must replay.
  stdin.write('abc\x1b');     // plain keys + a lone ESC that could open an answer
  await new Promise((r) => setTimeout(r, 220)); // window times out + heals
  const after = writes.slice(before).join('');
  assert.ok(after.includes(HEAL_ROW), 'timeout healed');
  // The plain keys replayed into the draft; the lone ESC is readline's
  // interrupt/sequence key — it may be swallowed or pending, but must never
  // appear as a draft character.
  assert.equal(rl.line, 'abc', `plain keys replayed cleanly: ${JSON.stringify(rl.line)}`);
  assert.ok(!rl.line.includes('\x1b'), 'no control bytes in the draft');
  // (Post-window keystroke liveness is covered by the TIMEOUT/CLEANUP tests;
  // here the replayed lone ESC legitimately pairs with the NEXT key the user
  // presses — identical to native readline for a real ESC keypress.)
  cleanup();
  bar.stop();
});

test('TIMEOUT: silent terminal heals conservatively and the window closes cleanly', async () => {
  const { bar, rl, stdin, writes, cleanup } = makeRig();
  bar.update();
  const before = writes.length;
  probeWith(bar, stdin);               // no answer will arrive
  await new Promise((r) => setTimeout(r, 200));
  const after = writes.slice(before).join('');
  assert.ok(after.includes(HEAL_ROW), 'silent terminal healed (re-bank at workspace bottom)');
  // The window is closed: further keystrokes flow straight to readline.
  stdin.write('ok');
  assert.equal(rl.line, 'ok', 'readline back in control after the timeout');
  cleanup();
  bar.stop();
});

test('CADENCE: the bar asks for a probe every 25 ticks only while docked', async () => {
  const { bar, cleanup } = makeRig();
  bar.poll(200);
  await new Promise((r) => setTimeout(r, 10));
  let probes = 0;
  bar.setSlotProbeFn(() => { probes++; });
  for (let i = 0; i < 100; i++) bar._slotTickForTest();
  assert.strictEqual(probes, 4, `4 probes per 100 ticks, got ${probes}`);
  bar.poll(0);
  cleanup();
  bar.stop();
});

test('CLEANUP: uninstall removes the probe seam (poll ticks never probe again)', async () => {
  const { bar, stdin, rl, cleanup } = makeRig();
  bar.poll(200);
  cleanup();
  assert.strictEqual(bar._slotProbeFn, null, 'probe seam removed by cleanup');
  // The bar's tick guard (`this._slotProbeFn && ...`) is the production
  // guarantee; prove it by installing a throwing probe and NOT being
  // invoked through the guarded tick path:
  bar.setSlotProbeFn(() => { throw new Error('must not probe'); });
  bar._slotProbeFn = null; // what cleanup left behind
  for (let i = 0; i < 30; i++) bar._slotTickForTest();
  bar.poll(0);
  bar.stop();
  // And stdin still processes input through readline after cleanup:
  stdin.write('z');
  assert.equal(rl.line, 'z', 'readline alive after cleanup');
});
