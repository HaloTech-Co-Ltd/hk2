/*-------------------------------------------------------------------------
 *
 * Regression tests for post-compaction status-bar refresh:
 *   /compact (ctx.compactConversation) and auto-compact (maybeAutoCompact)
 *   replace session.messages but historically left session.tokens frozen on
 *   the PRE-compact peak, so the status bar (formatUsage reads
 *   tokens.loopPeakIn) never updated. The fix applies a CALIBRATED estimate:
 *
 *     factor = pre-compact real peak input / pre-compact char estimate
 *     est    = post-compact char estimate × clamp(factor, 0.25, 4)
 *
 * which lands in callIn/loopPeakIn/lastContextTokens and refreshes the bar.
 *
 * Run:  node --test test/compact_statusbar.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSession,
  buildCtx,
  estimateMessagesTokens,
  applyCompactTokenEstimate,
  maybeAutoCompact,
} from '../src/commands/interactive.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INTERACTIVE = path.join(here, '..', 'src', 'commands', 'interactive.js');

const pad = (ch, n) => ch.repeat(n);

/* ── Unit: applyCompactTokenEstimate ─────────────────────────────────── */

test('applyCompactTokenEstimate calibrates with the pre-compact real peak', () => {
  const session = createSession();
  // Post-compact list: one 800-char message → raw estimate = 200.
  session.messages = [{ role: 'user', content: pad('x', 800) }];
  // Pre-compact real peak 4000 against pre-estimate 1000 → factor 4 (in range).
  const preEstimate = 1000;
  session.tokens.loopPeakIn = 4000;
  const updates = [];
  session.statusBar = { update: () => updates.push(1) };

  const est = applyCompactTokenEstimate(session, preEstimate);

  assert.equal(est, 800, '800-char post-compact × factor 4 = 800');
  assert.equal(session.tokens.callIn, 800);
  assert.equal(session.tokens.loopPeakIn, 800);
  assert.equal(session.lastContextTokens, 800);
  assert.ok(updates.length >= 1, 'status bar refreshed');
});

test('applyCompactTokenEstimate falls back to the raw estimate without real data', () => {
  const session = createSession();
  session.messages = [{ role: 'user', content: pad('y', 400) }]; // → 100 tokens
  session.tokens.loopPeakIn = 0;
  session.tokens.callIn = 0;
  session.lastContextTokens = 0;

  const est = applyCompactTokenEstimate(session, 50);

  assert.equal(est, 100, 'no real measurement → raw chars/4 estimate');
  assert.equal(session.tokens.loopPeakIn, 100);
});

test('applyCompactTokenEstimate clamps a degenerate calibration factor', () => {
  const session = createSession();
  session.messages = [{ role: 'user', content: pad('z', 400) }]; // → 100 tokens
  // real 40000 / pre 100 = 400 → clamped to 4 → est 400.
  session.tokens.loopPeakIn = 40000;
  assert.equal(applyCompactTokenEstimate(session, 100), 400);

  // real 1 / pre 10000 → factor 0.0001 → clamped to 0.25 → est 25.
  const s2 = createSession();
  s2.messages = [{ role: 'user', content: pad('z', 400) }];
  s2.tokens.loopPeakIn = 1;
  assert.equal(applyCompactTokenEstimate(s2, 10000), 25);
});

test('estimate never exceeds a fresh real usage event path (turn-start reset precedes usage)', () => {
  // Source-order contract: both stream entry points zero callIn/loopPeakIn
  // before the first usage event, so an estimate written by compaction can
  // never mask a smaller-but-real first measurement.
  const src = fs.readFileSync(INTERACTIVE, 'utf8');
  const resetIdx = src.indexOf('session.tokens.loopPeakIn = 0;');
  assert.ok(resetIdx > 0, 'token reset present');
  const usageIdx = src.indexOf("if (typeof u.input === 'number'");
  assert.ok(usageIdx > resetIdx, 'usage handler comes after a reset');
});

/* ── Wiring: /compact (ctx.compactConversation) ──────────────────────── */

test('/compact refreshes token accounting and the status bar with a calibrated estimate', async () => {
  const session = createSession();
  // 6 user/assistant turns (minimum compactMessages accepts) + system head.
  session.messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: pad('a', 400) },
    { role: 'assistant', content: pad('b', 400) },
    { role: 'user', content: pad('c', 400) },
    { role: 'assistant', content: pad('d', 400) },
    { role: 'user', content: pad('e', 400) },
    { role: 'assistant', content: pad('f', 400) },
  ];
  session.llm = null; // no summarizer → deterministic naive fallback
  session.tokens.loopPeakIn = 6000; // pre-compact real peak from last turn
  session.lastContextTokens = 6000;
  const updates = [];
  session.statusBar = { update: () => updates.push(1) };

  const preEstimate = estimateMessagesTokens(session.messages);
  const ctx = buildCtx(session);
  await ctx.compactConversation();

  // Compaction happened: a summary system message now leads the history.
  assert.ok(
    session.messages.some(m => m.role === 'system' && String(m.content).startsWith('## Prior conversation (compacted)')),
    'compacted summary present'
  );
  // Calibrated estimate wired through all three consumers.
  const postEstimate = estimateMessagesTokens(session.messages);
  const factor = Math.max(0.25, Math.min(4, 6000 / preEstimate));
  const expected = Math.round(postEstimate * factor);
  assert.equal(session.tokens.loopPeakIn, expected, `loopPeakIn = calibrated ${expected}`);
  assert.equal(session.tokens.callIn, expected);
  assert.equal(session.lastContextTokens, expected);
  // Compaction must visibly shrink the bar's context number.
  assert.ok(expected < 6000, 'estimated context is below the pre-compact peak');
  assert.ok(updates.length >= 1, 'status bar refreshed after /compact');
});

/* ── Wiring: auto-compact (maybeAutoCompact) ──────────────────────────── */

test('auto-compact captures the pre-compact estimate BEFORE swapping messages', async () => {
  // Source-order contract: preEstimate must be computed from the ORIGINAL
  // (pre-compact) list — capturing it after the swap would calibrate the
  // estimator against the wrong baseline.
  const src = fs.readFileSync(INTERACTIVE, 'utf8');
  const fnStart = src.indexOf('async function maybeAutoCompact');
  assert.ok(fnStart >= 0, 'maybeAutoCompact found');
  const fnEnd = src.indexOf('\nfunction ', fnStart);
  const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
  const preIdx = body.indexOf('const preEstimate = estimateMessagesTokens(session.messages);');
  const swapIdx = body.indexOf('session.messages = out.messages;');
  const applyIdx = body.indexOf('applyCompactTokenEstimate(session, preEstimate);');
  assert.ok(preIdx >= 0, 'preEstimate captured');
  assert.ok(swapIdx > preIdx, 'messages swapped AFTER preEstimate capture');
  assert.ok(applyIdx > swapIdx, 'calibrated estimate applied AFTER the swap');
  // The old raw-guess assignment must be gone from maybeAutoCompact.
  assert.ok(!body.includes('session.lastContextTokens = estimateMessagesTokens'), 'raw guess replaced by calibrated estimate');
});

test('maybeAutoCompact applies the calibrated estimate end-to-end', async () => {
  const session = createSession();
  const msgs = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: pad('q', 500) });
  }
  session.messages = msgs;
  session.llm = null;
  session.modelCfg = { maxChars: 1000 }; // tiny window → threshold surely exceeded
  // Pre-compact real measurement from the previous turn.
  session.tokens.loopPeakIn = 0;         // already reset at this point in real flow? No:
  session.tokens.callIn = 0;             // maybeAutoCompact runs BEFORE the reset,
  session.lastContextTokens = 4000;      // so lastContextTokens carries the real peak.
  const updates = [];
  session.statusBar = { update: () => updates.push(1) };

  process.env.HK2_ENABLE_AUTOCOMPACT = '1';
  process.env.HK2_AUTOCOMPACT_PCTUSED = '90';
  try {
    await maybeAutoCompact(session, { print: () => {} });
  } finally {
    delete process.env.HK2_ENABLE_AUTOCOMPACT;
    delete process.env.HK2_AUTOCOMPACT_PCTUSED;
  }

  assert.ok(
    session.messages.some(m => m.role === 'system' && String(m.content).startsWith('## Prior conversation (compacted)')),
    'auto-compaction ran'
  );
  // real = max(loopPeakIn, callIn, lastContextTokens) = 4000 here.
  const postEstimate = estimateMessagesTokens(session.messages);
  const preEstimate = estimateMessagesTokens([
    ...msgs,
  ]);
  const factor = Math.max(0.25, Math.min(4, 4000 / preEstimate));
  assert.equal(session.lastContextTokens, Math.round(postEstimate * factor));
  assert.ok(session.lastContextTokens > 0, 'estimate is non-zero');
});
