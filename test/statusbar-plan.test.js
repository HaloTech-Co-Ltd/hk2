/*-------------------------------------------------------------------------
 *
 * Unit tests for the StatusBar variable-bottom-region extension: verifies the
 * pinned plan-progress block grows/shrinks the reserved scroll region and
 * clears ghost lines when the block shrinks. Uses a fake TTY stream.
 *
 * Run:  node --test test/statusbar-plan.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { StatusBar } from '../lib/agent/statusbar.js';

function makeBar(planRenderer) {
  const writes = [];
  const fakeStream = { isTTY: true, columns: 80, write: (s) => { writes.push(s); } };
  // Force a stable terminal size so row math is deterministic.
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
  Object.defineProperty(process.stderr, 'rows', { value: 24, configurable: true });
  let planLines = [];
  const bar = new StatusBar(fakeStream, {
    formatter: () => 'STATUS',
    planRenderer: planRenderer || (() => planLines),
  });
  bar._started = true; // bypass start()'s resize-handler side effects
  // Concatenate all writes for assertion convenience.
  const all = () => writes.join('');
  return { bar, writes, all, setPlan: (lines) => { planLines = lines; } };
}

test('StatusBar is enabled with a TTY stream', () => {
  const { bar } = makeBar();
  assert.equal(bar.isEnabled(), true);
});

test('no plan block -> status line written on the bottom row', () => {
  const { bar, all } = makeBar();
  bar.update();
  assert.ok(all().endsWith('STATUS\x1b8'), 'status line written on the bottom row');
  assert.equal(bar._planLineCount, 0);
});

test('plan block of N lines shrinks the region to rows-1-N on the transition', () => {
  const { bar, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a', '  [ ] 2. b']); // 3 lines
  bar.update();
  const w = all();
  // region 1..(24-1-3) = 1..20
  assert.ok(w.includes('\x1b[1;20r'), 'scroll region shrunk to 1..20');
  assert.ok(w.includes('Plan: x'), 'plan header rendered');
  assert.ok(w.includes('STATUS'), 'status line still on the bottom');
  assert.equal(bar._planLineCount, 3);
});

test('plan block shrinking clears the released ghost lines', () => {
  const { bar, writes, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a', '  [ ] 2. b']);
  bar.update(); // grows to 3
  writes.length = 0;
  setPlan([]); // cleared
  bar.update();
  const w = all();
  // region back to 1..23
  assert.ok(w.includes('\x1b[1;23r'), 'scroll region restored to 1..23');
  // The 3 former plan rows + the status row must all be cleared (4+ \x1b[2K).
  const clearCount = (w.match(/\x1b\[2K/g) || []).length;
  assert.ok(clearCount >= 4, `expected >=4 clear-line ops to kill ghosts, got ${clearCount}`);
  assert.equal(bar._planLineCount, 0);
});

test('plan block growth from 0 to N re-establishes the region before drawing', () => {
  const { bar, writes, all, setPlan } = makeBar();
  bar.update(); // 0 plan lines, no transition
  writes.length = 0;
  setPlan(['Plan: x', '  > 1. a']); // grow to 2
  bar.update();
  const w = all();
  // region 1..(24-1-2) = 1..21
  assert.ok(w.includes('\x1b[1;21r'), 'region shrunk to 1..21 on growth');
  assert.ok(w.includes('Plan: x'));
  assert.equal(bar._planLineCount, 2);
});

test('a GROW transition parks the cursor at the bottom of the new workspace, not in the reserved block', () => {
  // Regression: after plan confirmation the cursor was restored (\x1b8) to the
  // position saved at the bottom of the OLD, larger workspace - a position that
  // now lives INSIDE the newly pinned plan block. The spinner / streaming
  // output then overwrote the block, so the confirmation text lingered while
  // execution output rendered above it. On a grow transition the cursor must
  // instead be parked at the bottom of the NEW scroll workspace (rows-1-N).
  const { bar, writes, all, setPlan } = makeBar();
  bar.update(); // 0 plan lines
  writes.length = 0;
  setPlan(['Plan: x', '  > 1. a']); // grow 0 -> 2
  bar.update();
  const w = all();
  // New scroll workspace bottom = rows(24) - 1 - planCount(2) = 21.
  // The grow path must emit a cursor-position to row 21 and must NOT emit the
  // bare restore (\x1b8) that would drop the cursor back into the block.
  assert.ok(w.includes('\x1b[21;1H'), 'cursor parked at the bottom of the new workspace on grow');
  assert.ok(!/\x1b8$/.test(w), 'grow transition does not end with a bare cursor-restore');
});

test('a steady-state update restores the cursor (does not park it)', () => {
  // Steady-state (no height change) keeps the save+restore so the 500ms poll
  // does not move the user's cursor while typing at the prompt.
  const { bar, writes, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a']);
  bar.update(); // transition -> parks cursor
  writes.length = 0;
  bar.update(); // steady state
  const w = all();
  assert.ok(/\x1b8$/.test(w), 'steady-state update ends with cursor-restore');
});

test('a steady-state update (no count change) does NOT re-emit the scroll region', () => {
  const { bar, writes, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a']);
  bar.update(); // transition -> emits region
  writes.length = 0;
  bar.update(); // steady state -> no region re-emit
  const w = all();
  assert.ok(!w.includes('\x1b[1;'), 'no scroll-region re-emit on steady-state update');
  assert.ok(w.includes('STATUS'), 'status line still refreshed');
});

test('setPlanRenderer re-establishes the region immediately', () => {
  const { bar } = makeBar();
  bar.setPlanRenderer(() => ['Plan: x', '  > 1. a']);
  // _applyScrollRegion(true) -> update() runs; _planLineCount should reflect 2.
  assert.equal(bar._planLineCount, 2);
});

test('_renderPlanLines truncates to terminal width and drops trailing empties', () => {
  const { bar } = makeBar(() => ['short', '', '   ']);
  bar._cols = () => 10;
  const lines = bar._renderPlanLines();
  // trailing whitespace-only lines dropped -> only ['short'] remains
  assert.deepEqual(lines, ['short']);
});

test('plan completion shrink (N->0) reflows workspace and does not overlap prior output', () => {
  // Regression: when the last plan_step clears the block (N->0) mid-turn, the
  // scroll workspace grows. Output already written during the smaller-region
  // era was at fixed rows up to the OLD workspace bottom; restoring the cursor
  // to that stale position made the final summary land ON TOP of prior output.
  // The fix reflows: scroll the OLD workspace up by the released rows (SU)
  // within the OLD region, then switch to the new (larger) region, then park
  // the cursor at the new workspace bottom (not a stale restore).
  const { bar, writes, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a', '  [ ] 2. b', '  [ ] 3. c']); // 4 lines
  bar.update(); // grow to 4 -> region 1..(24-1-4)=1..19
  assert.equal(bar._planLineCount, 4);
  writes.length = 0;
  setPlan([]); // plan completes -> shrink 4 -> 0
  bar.update();
  const w = all();
  // The OLD workspace bottom was rows-1-prevCount = 24-1-4 = 19. The reflow
  // must point the scroll region at 1..19 and emit an SU by `released`=4.
  assert.ok(w.includes('\x1b[1;19r'), 'reflow targets the OLD workspace region 1..19');
  assert.ok(/\x1b\[4S/.test(w), 'scroll-up by the released row count (4) reflows prior output up');
  // The NEW region (1..23, full) must be set before the cursor parks.
  assert.ok(w.includes('\x1b[1;23r'), 'scroll region restored to the full 1..23');
  // Cursor must be parked at the NEW workspace bottom (24-1-0 = 23), NOT
  // restored (\x1b8) to a stale saved position that would overlap prior output.
  assert.ok(w.includes('\x1b[23;1H'), 'cursor parked at the new workspace bottom (row 23)');
  assert.ok(!/\x1b8$/.test(w), 'shrink transition does not end with a stale cursor-restore');
  assert.equal(bar._planLineCount, 0);
});

test('partial shrink (N->M) also reflows and parks, not restores', () => {
  // A step completing (in_progress strategy sub-line disappears) shrinks the
  // block by 1 line. Same reflow/park behavior must apply.
  const { bar, writes, all, setPlan } = makeBar();
  setPlan(['Plan: x', '  > 1. a', '     strat', '  [ ] 2. b']); // 4 lines
  bar.update();
  writes.length = 0;
  setPlan(['Plan: x', '  ✓ 1. a', '  > 2. b']); // 3 lines
  bar.update();
  const w = all();
  // OLD bottom = 24-1-4 = 19; released = 1.
  assert.ok(w.includes('\x1b[1;19r'), 'reflow targets old region 1..19');
  assert.ok(/\x1b\[1S/.test(w), 'scroll-up by 1');
  // NEW region = 24-1-3 = 20.
  assert.ok(w.includes('\x1b[1;20r'), 'region set to new 1..20');
  assert.ok(!/\x1b8$/.test(w), 'partial shrink parks cursor, no stale restore');
});
