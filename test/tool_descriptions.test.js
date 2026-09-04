/*-------------------------------------------------------------------------
 * Test: runtime tool/prompt description semantics.
 *
 * These assertions pin the *description-level contract* the documentation
 * is written against: text-only read with hard size limits, walker vs
 * .gitignore, BFS call chains, best-effort resolve rollback, plan_step's
 * current-step semantics, and the /kb init summary entry ids. They assert
 * key phrases only — never full description text — so wording tweaks do
 * not break them, while factual regressions (e.g. an images claim coming
 * back) do.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTools } from '../lib/agent/tools.js';
import { buildSystemPrompt } from '../lib/agent/system_prompt.js';

// Built-ins are always registered; KB tools require a runtime object, so a
// minimal stub rt is passed to pull the kb_* group into the registry.
const tools = buildTools({}, {});
const byName = (n) => {
  const t = tools.find((x) => x.name === n);
  assert.ok(t, `tool ${n} registered`);
  return t;
};

test('read description: text-only, 5 MiB cap, NUL heuristic, no images claim', () => {
  const d = byName('read').description;
  assert.ok(/UTF-8 text/i.test(d), 'states UTF-8 text');
  assert.match(d, /5 MiB/);
  assert.match(d, /NUL/);
  assert.doesNotMatch(d, /image|jpg|png|gif|webp|bmp/i, 'must not claim image support');
});

test('find/grep snippets: no .gitignore claim; walker skips stated', () => {
  for (const n of ['find', 'grep']) {
    const t = byName(n);
    const text = `${t.snippet} ${t.description ?? ''}`;
    assert.doesNotMatch(text, /respects\s+\.gitignore/i, `${n} must not claim .gitignore support`);
  }
  assert.match(byName('find').snippet, /skips \.git and node_modules/);
});

test('kb_callchain description: BFS, not DFS', () => {
  const d = byName('kb_callchain').description;
  assert.match(d, /BFS|breadth-first/i);
  assert.doesNotMatch(d, /DFS|depth-first/i);
});

test('kb_neighbors description: one-hop outgoing, no direction parameter', () => {
  const d = byName('kb_neighbors').description;
  assert.match(d, /OUTGOING|outgoing/i);
  assert.match(d, /no direction parameter/i);
});

test('resolve description: best-effort rollback, non-transactional, no strong commit wording', () => {
  const d = byName('resolve').description;
  assert.match(d, /best-effort/i);
  assert.match(d, /not a transactional guarantee/i);
  assert.doesNotMatch(d, /two-phase commit/i);
});

test('plan_step description: advances the current step; step arg never jumps', () => {
  const d = byName('plan_step').description;
  assert.match(d, /CURRENT/i);
  assert.match(d, /never jump|ignored for the mutation/i);
  assert.doesNotMatch(d, /selects? the step/i, 'must not claim parameter-selected steps');
});

test('bash description: default 60s and hard cap 60s', () => {
  const d = byName('bash').description;
  assert.match(d, /default 60/);
  assert.match(d, /hard-cap|capped/i);
});

test('system prompt: /kb init summaries are overview/diagram/decisions, conditional on an LLM', async () => {
  const prompt = buildSystemPrompt({ project: { name: 'p' }, tools: [] });
  const block = prompt.slice(prompt.indexOf('project-overview'), prompt.indexOf('project-overview') + 800);
  assert.match(prompt, /architecture-diagram/, 'architecture-diagram present');
  assert.match(prompt, /architecture-decisions/, 'architecture-decisions present');
  const initSummary = prompt.slice(
    prompt.lastIndexOf('three Eden', prompt.indexOf('architecture-diagram')),
    prompt.indexOf('architecture-decisions') + 40,
  );
  assert.doesNotMatch(initSummary, /api-docs/, 'api-docs must not be listed as a /kb init summary');
  assert.match(prompt, /when an LLM\s+is\s+configured|when an LLM is configured/, 'LLM condition stated');
  assert.doesNotMatch(prompt, /bounded DFS/i, 'no DFS wording in the prompt');
  assert.match(prompt, /BFS|breadth-first/i);
});
