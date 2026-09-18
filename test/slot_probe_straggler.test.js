// Regression tests for the POST-WINDOW STRAGGLER FILTER — the "R reappeared"
// recurrence: a DSR answer arriving AFTER the 160ms isolation window timed out
// (libuv runs the timeout timer before same-batch tty reads when the main
// thread was blocked by tool output). The answer landed on readline's
// re-attached listener and its printable 'R' hit the mid-task draft.
//
// The fix: after a timeout heal (or mid-window shutdown), a mini-window filter
// owns stdin, strips exactly the pending DSR answer(s), and disarms —
// re-attaching readline and replaying every non-answer byte.
import './_tty_env.js';
import { test } from 'node:test';
import assert from 'node:assert';
import readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StatusBar } from '../lib/agent/statusbar.js';
import { installSlotProbe } from '../lib/agent/slot_probe.js';

function makeRig({ rows = 24, cols = 80 } = {}) {
  const writes = [];
  const fakeStream = new Writable({ write(chunk, _enc, cb) { writes.push(chunk.toString()); cb(); } });
  fakeStream.isTTY = true; fakeStream.columns = cols; fakeStream.rows = rows;
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: rows, configurable: true });
  const bar = new StatusBar(fakeStream, {
    formatter: () => 'STATUS', planRenderer: () => [], inputRenderer: () => ['> box'],
  });
  bar.setInputCursorFn(() => 5);
  bar.start(); bar.update();
  const stdin = new PassThrough();
  stdin.isTTY = true; stdin.setRawMode = () => {};
  const rl = readline.createInterface({ input: stdin, output: fakeStream, terminal: true, prompt: 'P> ' });
  rl.prompt();
  const cleanup = installSlotProbe(stdin, bar);
  return { bar, rl, stdin, writes, cleanup };
}

test('LATE ANSWER after timeout heal: straggler filter eats it, no R in draft', async () => {
  const { bar, rl, stdin, writes, cleanup } = makeRig();
  stdin.write('add inst');
  bar._slotProbeFn?.();                    // window opens, no answer yet
  await new Promise((r) => setTimeout(r, 220)); // >160ms: timeout heal + filter armed
  assert.ok(writes.join('').includes('22;1H'), 'timeout healed');
  stdin.write('\x1b[24;1R');               // the LATE answer arrives post-window
  stdin.write('ruction');                  // user keeps typing right after it
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'add instruction', `no stray R/digits, keys intact: ${JSON.stringify(rl.line)}`);
  assert.ok(!rl.line.includes('R'), 'no R character leaked');
  cleanup(); bar.stop();
});

test('LATE FRAGMENTED answer after timeout: (ESC[ | 24;1R) completes post-window, consumed', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  stdin.write('\x1b[');
  stdin.write('24;1R');
  stdin.write('tail');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'tail', `fragmented straggler consumed, keys replayed: ${JSON.stringify(rl.line)}`);
  cleanup(); bar.stop();
});

test('LATE 3-FRAGMENT answer after timeout: (ESC[ | 24;1 | R) all consumed, no digit/R leak', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  stdin.write('k1');
  stdin.write('\x1b[');          // fragment 1: opener
  stdin.write('24;1');           // fragment 2: digits — unambiguously answer-shaped, held
  stdin.write('R');              // fragment 3: terminator — completes the answer in-filter
  stdin.write('k2');             // honest keys after it must still arrive
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'k1k2', `3-fragment straggler consumed, keys replayed: ${JSON.stringify(rl.line)}`);
  assert.ok(!rl.line.includes('R') && !rl.line.includes('24'), `no digit/R leaked: ${JSON.stringify(rl.line)}`);
  cleanup(); bar.stop();
});

test('straggler tail that never completes: bounded hunt gives the stream back', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  // `\x1b[5` looks like an answer opener but never completes — after the
  // chunk bound the filter must stop owning the stream and replay the bytes.
  stdin.write('\x1b[5');
  for (let i = 0; i < 10; i++) stdin.write('.');   // plain chunks push past the bound
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!rl.line.includes('\x1b'), 'held bytes eventually replayed, no control chars stuck');
  assert.ok(rl.line.includes('.'), `stream returned to readline: ${JSON.stringify(rl.line)}`);
  cleanup(); bar.stop();
});

test('no straggler in flight: post-timeout typing flows straight through (byte-exact)', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  stdin.write('plain');                       // first chunk has no answer shape
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'plain', `no double-delivery, no eaten keys: ${JSON.stringify(rl.line)}`);
  stdin.write('keys');
  assert.equal(rl.line, 'plainkeys', 'filter self-disarmed; stream back to readline');
  cleanup(); bar.stop();
});

test('user ESC passthrough while filter armed: never dropped, never duplicated', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  stdin.write('abc\x1b');                       // plain keys + bare ESC held back
  stdin.write('\x1b[24;1R');                    // then the real straggler answer
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'abc', `keys replayed, ESC not a draft char: ${JSON.stringify(rl.line)}`);
  assert.ok(!rl.line.includes('\x1b'), 'no control bytes in the draft');
  cleanup(); bar.stop();
});

test('mid-window REPL shutdown: late answer after cleanup is still filtered', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();                    // window opens
  stdin.write('ig');                       // keys during the window (replay dropped at shutdown — documented)
  cleanup();                               // mid-window shutdown arms the filter
  stdin.write('\x1b[24;1R');               // the late answer must not reach readline
  stdin.write('nore');                     // but honest keys after it must
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'nore', `answer eaten after shutdown, keys delivered: ${JSON.stringify(rl.line)}`);
  assert.ok(!rl.line.includes('R'), 'no R leaked post-shutdown');
});

test('answer + keys in ONE post-timeout chunk: answer stripped, keys kept, order kept', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // timeout: filter armed
  stdin.write('X\x1b[24;1RY');                  // keys around the straggler answer
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'XY', `keys kept in order, answer gone: ${JSON.stringify(rl.line)}`);
  cleanup(); bar.stop();
});

test('probe after a timed-out probe: no window/straggler interference', async () => {
  const { bar, rl, stdin, cleanup } = makeRig();
  bar._slotProbeFn?.();
  await new Promise((r) => setTimeout(r, 220)); // first probe times out; filter armed
  bar._slotProbeFn?.();                        // second probe disarms and re-windows
  stdin.write('k1');
  stdin.write('\x1b[10;1R');                   // in-window answer this time (healthy)
  await new Promise((r) => setTimeout(r, 30));
  stdin.write('k2');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rl.line, 'k1k2', `two probe cycles, keys all delivered: ${JSON.stringify(rl.line)}`);
  cleanup(); bar.stop();
});
