// Slash-command shape guard regression tests.
//
// Root cause being pinned here: `dispatchSlash` used to treat ANY line whose
// first character is `/` as a command attempt, so user lines like
// `/Users/zhangchenxi/Workspace/hk2/xxxx.md已更新，你需要…` (an absolute path
// glued to prose) were swallowed by the "Unknown command" branch and never
// reached the agent. The guard is shape-based and example-agnostic — these
// tests pin the input FAMILIES, not just the one reported example.

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  looksLikeSlashCommand,
  isPlausibleCommandName,
  suggestCommand,
} from '../lib/slash_command.js';
import { dispatchSlash, SLASH_COMMANDS } from '../src/slash/index.js';
import { captureMidTaskInput } from '../src/commands/session_ctx.js';
import { MultiLineCollector } from '../lib/agent/multiline.js';

/* ── 1. looksLikeSlashCommand: shape families ─────────────────────────── */

test('paths and glued text starting with / are NOT commands', () => {
  // The reported family: absolute path + glued CJK prose.
  assert.equal(looksLikeSlashCommand('/Users/zhangchenxi/Workspace/hk2/xxxx.md已更新，你需要重新分析'), false);
  // Bare absolute paths of every flavor.
  assert.equal(looksLikeSlashCommand('/usr/local/bin/node'), false);
  assert.equal(looksLikeSlashCommand('/tmp/x.txt'), false);
  assert.equal(looksLikeSlashCommand('/etc/nginx/nginx.conf'), false);
  // Hidden files / tilde forms.
  assert.equal(looksLikeSlashCommand('/.gitignore'), false);
  assert.equal(looksLikeSlashCommand('/~/notes.txt'), false);
  // CJK glued directly onto an ASCII head (no spaces around CJK).
  assert.equal(looksLikeSlashCommand('/foo已更新'), false);
  assert.equal(looksLikeSlashCommand('/model已更新，你需要处理'), false);
  // URLs are text (double slash).
  assert.equal(looksLikeSlashCommand('//example.com/x'), false);
  // Plain prose and empties are never commands.
  assert.equal(looksLikeSlashCommand('hello world'), false);
  assert.equal(looksLikeSlashCommand('   '), false);
  assert.equal(looksLikeSlashCommand(''), false);
  assert.equal(looksLikeSlashCommand(null), false);
});

test('real command heads ARE commands', () => {
  assert.equal(looksLikeSlashCommand('/model'), true);
  assert.equal(looksLikeSlashCommand('/help'), true);
  assert.equal(looksLikeSlashCommand('/kb knowledge search foo'), true);
  assert.equal(looksLikeSlashCommand('  /model use a/b'), true); // leading ws ok
  assert.equal(looksLikeSlashCommand('/mdoel'), true); // typo shape still routes to correction
});

/* ── 2. dispatchSlash: path lines flow to the agent ───────────────────── */

test('dispatchSlash lets path/text lines through (returns false, no swallow)', async () => {
  const prints = [];
  const ctx = { print: (t) => prints.push(t) };
  const lines = [
    '/Users/zhangchenxi/Workspace/hk2/xxxx.md已更新，你需要重新分析',
    '/tmp/report.md 已更新，请查看',
    '/etc/hosts是怎么配置的',
    '//registry.example.com 挂了',
  ];
  for (const line of lines) {
    const handled = await dispatchSlash(line, ctx);
    assert.equal(handled, false, `line must flow to agent: ${line}`);
  }
  assert.equal(prints.length, 0, 'no Unknown-command noise for text lines');
});

test('dispatchSlash still handles real commands', async () => {
  const prints = [];
  const ctx = {
    print: (t) => prints.push(t),
    exit: () => prints.push('__EXIT__'),
  };
  assert.equal(await dispatchSlash('/help', ctx), true);
  assert.ok(prints.length > 0, '/help printed the command list');
});

test('typo-shaped heads get did-you-mean instead of silent swallow', async () => {
  const prints = [];
  const ctx = { print: (t) => prints.push(t) };
  assert.equal(await dispatchSlash('/mdoel list', ctx), true);
  assert.ok(prints[0].includes("did you mean /model"), `got: ${prints[0]}`);
  // A plausible word with no close match stays an explicit Unknown command
  // (still handled=true — the hard boundary for typo feedback).
  prints.length = 0;
  assert.equal(await dispatchSlash('/zzzz', ctx), true);
  assert.ok(prints[0].includes('Unknown command'), `got: ${prints[0]}`);
});

/* ── 3. captureMidTaskInput: mid-turn path lines are captured ─────────── */

test('mid-task capture treats path-like lines as instructions, commands still excluded', () => {
  const s = { agentTurnActive: true };
  // A path+prose line arriving mid-turn must now be CAPTURED (previously it
  // fell into the legacy post-turn queue because of the raw startsWith check).
  assert.equal(captureMidTaskInput(s, '/Users/zhangchenxi/Workspace/hk2/notes.md已更新，继续'), true);
  assert.equal(s.userInputQueue.length, 1);
  // Real commands stay excluded (legacy post-turn behavior).
  assert.equal(captureMidTaskInput(s, '/model list'), false);
  assert.equal(captureMidTaskInput(s, '/help'), false);
});

/* ── 4. MultiLineCollector: pasted lines starting with / stay batched ─── */

test('multi-line paste: lines starting with / (paths) no longer split the burst', async () => {
  const flushed = [];
  const c = new MultiLineCollector({
    gapMs: 5000, // never time out during the test
    isPasting: () => false,
    onFlush: (text) => flushed.push(text),
  });
  // First line starts a burst (consumed, buffered).
  assert.equal(c.ingest('看这个配置文件:'), true);
  // A path-like line mid-burst: previously this FLUSHED and passed through
  // (splitting the paste); now it is just another burst line.
  assert.equal(c.ingest('/etc/nginx/nginx.conf里的server块'), true);
  assert.equal(c.ingest('需要检查proxy_pass'), true);
  c.flush();
  assert.equal(flushed.length, 1, 'burst flushed as ONE message');
  assert.ok(flushed[0].includes('/etc/nginx/nginx.conf'), 'path line kept in the burst');
  assert.equal(flushed[0].split('\n').length, 3, 'all three lines survived');
});

test('multi-line paste: a real command mid-burst still splits (legacy behavior)', () => {
  const flushed = [];
  const c = new MultiLineCollector({
    gapMs: 5000,
    isPasting: () => false,
    onFlush: (text) => flushed.push(text),
  });
  assert.equal(c.ingest('看这个配置文件:'), true);
  assert.equal(c.ingest('/model list'), false, 'real command passes through');
  assert.equal(flushed.length, 1, 'pending burst flushed first');
  assert.equal(flushed[0], '看这个配置文件:');
});

/* ── 5. suggestion helpers ────────────────────────────────────────────── */

test('suggestCommand: prefix and edit-distance matching', () => {
  const names = SLASH_COMMANDS.map(c => c.name);
  assert.equal(suggestCommand('model', names), '/model');
  assert.equal(suggestCommand('mod', names), '/model');   // prefix
  assert.equal(suggestCommand('mdoel', names), '/model'); // transposition
  assert.equal(suggestCommand('zzzzzz', names), null);    // nothing close
  assert.equal(isPlausibleCommandName('mdoel'), true);
  assert.equal(isPlausibleCommandName('Users/zhangchenxi'), false);
  assert.equal(isPlausibleCommandName('foo已更新'), false);
});
