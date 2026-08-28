/* Filesystem-permission sandbox prompt injection test.
 * Run: node --test test/permission_prompt.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { buildSystemPrompt } from '../lib/agent/system_prompt.js';
import { summarizePermissionsForPrompt } from '../lib/config/setting.js';

const RULES = [
  { abs: '/data/reports', recursive: true, effect: 'allow', modes: new Set(['r']), source: 'project' },
  { abs: '/tmp/scratch.txt', recursive: false, effect: 'deny', modes: new Set(['w', 'x']), source: 'global' },
];

test('summarizePermissionsForPrompt renders roots and rules compactly', () => {
  const { text, roots, rules } = summarizePermissionsForPrompt({
    rules: RULES,
    roots: ['/Users/me/proj'],
  });
  assert.deepStrictEqual(roots, ['/Users/me/proj']);
  assert.strictEqual(rules.length, 2);
  assert.ok(text.includes('/Users/me/proj'), 'roots listed');
  assert.ok(text.includes('ALLOWED'), 'inside-roots allow statement');
  assert.ok(text.includes('allow r: /data/reports/** [project]'), 'recursive allow rule rendered');
  assert.ok(text.includes('deny wx: /tmp/scratch.txt [global]'), 'deny rule rendered');
});

test('summarizePermissionsForPrompt handles the no-rules case', () => {
  const { text } = summarizePermissionsForPrompt({ rules: [], roots: ['/p'] });
  assert.ok(text.includes('No extra setting.json rules'));
  assert.ok(text.includes('DENIED'));
});

test('buildSystemPrompt renders the sandbox section from permissionSummary', () => {
  const summary = summarizePermissionsForPrompt({ rules: RULES, roots: ['/Users/me/proj'] });
  const prompt = buildSystemPrompt({ permissionSummary: summary.text, graphText: 'kb stuff' });
  assert.ok(prompt.includes('# Filesystem permission sandbox'), 'section header present');
  assert.ok(prompt.includes('permission denied'), 'denied-error guidance present');
  assert.ok(prompt.includes('allow r: /data/reports/** [project]'), 'rule lines included');
  assert.ok(prompt.includes('setting.json'), 'points user at the fix');
  assert.ok(!prompt.includes('undefined'), 'no leaked undefined');
});

test('buildSystemPrompt omits the sandbox section when summary is empty/absent', () => {
  const p1 = buildSystemPrompt({ graphText: 'x' });
  assert.ok(!p1.includes('# Filesystem permission sandbox'));
  const p2 = buildSystemPrompt({ permissionSummary: '   ', graphText: 'x' });
  assert.ok(!p2.includes('# Filesystem permission sandbox'));
});

test('sandbox section sits between supreme code and KB context', () => {
  const prompt = buildSystemPrompt({
    supremeCodes: ['law one'],
    permissionSummary: '- roots: /p',
    graphText: '# Knowledge-base context\nstuff',
  });
  const iSupreme = prompt.indexOf('# Project Supreme Code');
  const iSandbox = prompt.indexOf('# Filesystem permission sandbox');
  const iKb = prompt.indexOf('# Knowledge-base context');
  assert.ok(iSupreme >= 0 && iSandbox > iSupreme, 'sandbox after supreme code');
  assert.ok(iKb < 0 || iSandbox < iKb, 'sandbox before KB graph');
});
