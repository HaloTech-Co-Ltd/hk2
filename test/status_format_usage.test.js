/*-------------------------------------------------------------------------
 * Test: status-bar usage numbers use PEAK values, not loop sums.
 *
 * formatUsage() must read loopPeakIn/loopPeakOut (falling back to the
 * single call's numbers). A loop with a big cumulative total but a smaller
 * per-call peak must display the peak — the context window constrains a
 * single call, not the sum.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUsage, fmtTok } from '../src/commands/status_format.js';

const strip = (s) => s.replace(/\[[0-9;]*m/g, '');

test('formatUsage displays loop PEAKS, not loop sums', () => {
  const tokens = { loopIn: 9000, loopOut: 3000, loopPeakIn: 2400, loopPeakOut: 700 };
  const out = strip(formatUsage(tokens, 128000));
  assert.ok(out.includes(fmtTok(2400)), `shows peak input 2400 (${out})`);
  assert.ok(out.includes(fmtTok(700)), `shows peak output 700 (${out})`);
  assert.ok(!out.includes(fmtTok(9000)), `must not show summed input 9000 (${out})`);
  assert.ok(!out.includes(fmtTok(3000)), `must not show summed output 3000 (${out})`);
});

test('formatUsage falls back to the single call numbers when no peaks recorded', () => {
  const out = strip(formatUsage({ callIn: 500, callOut: 50 }, 1000));
  assert.ok(out.includes(fmtTok(500)) && out.includes(fmtTok(50)));
});

test('percentage is peak input over context window', () => {
  const out = strip(formatUsage({ loopPeakIn: 1280, loopPeakOut: 10 }, 128000));
  assert.match(out, /1\.?0?%/);
});
