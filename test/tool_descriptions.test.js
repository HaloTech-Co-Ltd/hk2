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
  assert.match(d, /non-transactional|not a transactional guarantee/i);
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

test('read description: UTF-8 text, 5 MiB, NUL heuristic, no images claim', () => {
  const t = byName('read');
  const d = t.description;
  assert.ok(/UTF-8 text/i.test(d), 'states UTF-8 text');
  assert.match(d, /5 MiB/);
  assert.match(d, /NUL/);
  assert.doesNotMatch(`${d} ${t.snippet}`, /image|jpg|png|gif|webp|bmp/i, 'no image claim');
  assert.match(d, /first requested line/i, 'line-granular byte cap noted');
});

test('resolve: best-effort, non-transactional, no logged claim', () => {
  const d = byName('resolve').description;
  assert.match(d, /best-effort/i);
  assert.match(d, /non-transactional/i);
  assert.doesNotMatch(d, /logged/i, 'must not claim rollback failures are logged');
});

test('plan_step: top description AND step param say current-step semantics', () => {
  const t = byName('plan_step');
  assert.match(t.description, /CURRENT/i);
  const stepDesc = t.parameters?.properties?.step?.description || '';
  assert.match(stepDesc, /compatibility\/reporting hint|compatibility\/ reporting hint/i,
    'step param described as a hint');
  assert.match(stepDesc, /always advances the current/i);
  assert.doesNotMatch(stepDesc, /mark done/i, 'param must not claim step selection');
});

test('plan: recommended maxima vs runtime minimum distinguished', () => {
  const d = byName('plan').description;
  assert.match(d, /2-5 steps/i);
  assert.match(d, /minimum of two usable steps/i);
  assert.match(d, /no maximum/i);
});

test('kb_callchain: BFS + per-direction max_nodes', () => {
  const t = byName('kb_callchain');
  assert.match(t.description, /BFS|breadth-first/i);
  assert.match(t.description, /INDEPENDENTLY to each selected direction|independently to each selected direction/i);
  assert.match(t.description, /max_nodes - 1|max_nodes \?-\s?1/i);
  assert.doesNotMatch(t.description, /DFS|depth-first/i);
});

test('kb_neighbors: outgoing, no direction parameter', () => {
  const d = byName('kb_neighbors').description;
  assert.match(d, /OUTGOING|outgoing/i);
  assert.match(d, /no direction parameter/i);
});

test('kb_class: enum included', () => {
  const t = byName('kb_class');
  assert.match(`${t.description} ${t.snippet}`, /enum/i);
});

test('kb_implements: direct implementers, not transitive', () => {
  const d = byName('kb_implements').description;
  assert.match(d, /DIRECT|direct/i);
  assert.match(d, /not a recursive transitive closure|transitive/i);
});

test('find/grep: no .gitignore claim', () => {
  for (const n of ['find', 'grep']) {
    const t = byName(n);
    assert.doesNotMatch(`${t.snippet} ${t.description ?? ''}`, /respects\s+\.gitignore/i);
    assert.match(t.snippet, /skips \.git and node_modules/);
  }
});

test('bash: default 60 and hard cap 60', () => {
  const d = byName('bash').description;
  assert.match(d, /default 60/);
  assert.match(d, /hard-cap|capped at 60/i);
});

test('system prompt: conditional prefetch, hint buckets, permission causes, direct implements, Holy scope', async () => {
  const prompt = buildSystemPrompt({ project: { name: 'p' }, tools: [], permissionSummary: 'sandbox on' });
  assert.match(prompt, /When a "Knowledge-base context" block is present/i, 'prefetch is conditional');
  assert.match(prompt, /shared standalone-search bucket|shared standalone-search/i, 'hint buckets described');
  assert.match(prompt, /restricted inside them|OR restricted/i, 'permission causes include in-project rules');
  assert.match(prompt, /DIRECT implementers/i, 'implements is direct');
  assert.match(prompt, /Agent-proposed and automatic writes to Holy/i, 'Holy approval scoped to agent paths');
});
