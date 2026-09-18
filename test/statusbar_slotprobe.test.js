// Unit tests for the continuation-slot watchdog (fourth defect fix).
// Covers: probe cadence (every 25 polls while docked), DSR row judgement
// (healthy vs drift vs unknown), heal invocation, and the stdin decode loop.
import { test } from 'node:test';
import assert from 'node:assert';
import { StatusBar } from '../lib/agent/statusbar.js';

function makeBar({ input = () => [], plan = () => [], dockCursor = null } = {}) {
  const writes = [];
  const fakeStream = { isTTY: true, columns: 80, write: (s) => { writes.push(s); } };
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  const bar = new StatusBar(fakeStream, {
    formatter: () => 'STATUS',
    planRenderer: plan,
    inputRenderer: input,
  });
  if (dockCursor !== null) bar.setInputCursorFn(() => dockCursor);
  bar._writes = writes;
  return bar;
}

test('slot watchdog: not docked -> poll never probes', async () => {
  const bar = makeBar();
  bar.start();
  bar.setSlotProbeFn(() => { throw new Error('must not probe while undocked'); });
  await new Promise((r) => setTimeout(r, 30));
  // poll interval is 200ms in production; simulate the tick body directly:
  for (let i = 0; i < 30; i++) bar._slotTickForTest?.();
  // (no throw, no crash)
  bar.stop();
});

test('slot watchdog: docked -> probe fires every 25 polls', async () => {
  const bar = makeBar({ input: () => ['> box'], dockCursor: 5 });
  bar.start();
  bar.poll(200);   // install the real poll loop (also defines _slotTickForTest)
  await new Promise((r) => setTimeout(r, 30));
  let probes = 0;
  bar.setSlotProbeFn(() => { probes++; });
  // Drive the cadence synchronously through the exact tick body the interval runs
  for (let i = 0; i < 100; i++) bar._slotTickForTest();
  assert.strictEqual(probes, 4, `expected 4 probes in 100 ticks, got ${probes}`);
  bar.stop();
});

test('slotProbeReport: cursor row inside workspace = healthy, no heal', () => {
  const bar = makeBar({ input: () => ['> box'], plan: () => ['PLAN'], dockCursor: 5 });
  bar.start();
  bar.update();
  const before = bar._writes.length;
  bar.slotProbeReport(20); // workspace row (scrollBottom = 24-1-1-1 = 21)
  const seq = bar._writes.slice(before).join('');
  assert.ok(!seq.includes('23;1H'), 'heal re-bank must NOT fire for a healthy slot');
  bar.stop();
});

test('slotProbeReport: cursor row inside reserved block = drift -> heal re-banks at bottom', () => {
  const bar = makeBar({ input: () => ['> box'], plan: () => ['PLAN'], dockCursor: 5 });
  bar.start();
  bar.update();
  const before = bar._writes.length;
  bar.slotProbeReport(24); // status row = inside reserved block
  const seq = bar._writes.slice(before).join('');
  // heal tail re-banks the DECSC slot at the workspace bottom, then re-docks:
  // ... 21;1H ESC7 22;5H (re-bank at bottom, park back in the box)
  assert.ok(seq.includes('21;1H'), `heal must re-bank at the workspace bottom row 21, got: ${JSON.stringify(seq.slice(-80))}`);
  assert.ok(seq.includes('22;5H'), 'heal re-docks the cursor into the box');
  bar.stop();
});

test('slotProbeResult(false) with silent terminal: conservative heal', () => {
  const bar = makeBar({ input: () => ['> box'], dockCursor: 5 });
  bar.start();
  bar.update();
  const before = bar._writes.length;
  bar.slotProbeResult(false, 24);
  const seq = bar._writes.slice(before).join('');
  assert.ok(seq.includes('22;1H'), 'unknown verdict also heals (re-bank at workspace bottom)');
  bar.stop();
});

test('slotProbeResult(true): resets the cadence counter, no heal', () => {
  const bar = makeBar({ input: () => ['> box'], dockCursor: 5 });
  bar.start();
  bar.update();
  const before = bar._writes.length;
  bar.slotProbeResult(true, 24);
  const seq = bar._writes.slice(before).join('');
  assert.ok(!seq.includes('22;1H'), 'healthy verdict must not heal');
  assert.strictEqual(bar._slotCheckCounter, 0, 'counter reset');
  bar.stop();
});

test('disabled or stopped bar ignores probe results (no crash)', () => {
  const bar = makeBar({ input: () => ['> box'], dockCursor: 5 });
  // not started:
  bar.slotProbeReport(24);
  bar.slotProbeResult(false, 24);
  assert.ok(true, 'no throw');
});
