/*-------------------------------------------------------------------------
 * Test: runtime tool/prompt description semantics.
 *
 * One test per semantic contract; assertions target key phrases in the
 * description, guidelines, and parameter descriptions — never full-text
 * equality. These pin the description-level contract the documentation is
 * written against, so factual regressions (an images claim returning, a
 * hard-max claim reappearing) fail here.
 *-------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTools, KbFirstGuard } from '../lib/agent/tools.js';
import { buildSystemPrompt } from '../lib/agent/system_prompt.js';
import { resetPermissionService } from '../lib/config/setting.js';

// Built-ins are always registered; KB tools require a runtime object, so a
// minimal stub rt pulls the kb_* group into the registry.
const tools = buildTools({}, { projectId: 'p-test', remember: async () => [] });
const byName = (n) => {
  const t = tools.find((x) => x.name === n);
  assert.ok(t, `tool ${n} registered`);
  return t;
};
const allText = (t) => `${t.snippet} ${t.description ?? ''} ${(t.guidelines ?? []).join(' ')}`;

test('read: text-only, 5 MiB, NUL heuristic, line-boundary cap, no images claim', () => {
  const t = byName('read');
  const d = t.description;
  assert.ok(/UTF-8 text/i.test(d), 'states UTF-8 text');
  assert.match(d, /5 MiB/);
  assert.match(d, /NUL/);
  assert.match(d, /first requested line/i, 'line-granular byte cap');
  assert.doesNotMatch(allText(t), /\b(jpg|png|gif|webp|bmp)\b|supports.*images|Images are sent/i, 'no image-attachment claim (negative wording allowed)');
});

test('bash: no 2000-line claim; per-stream ~8 KiB; timeout semantics + negative caveat', () => {
  const t = byName('bash');
  const d = t.description;
  assert.match(d, /independently truncated/i, 'per-stream budgets');
  assert.match(d, /8 KiB/i);
  assert.doesNotMatch(d, /2000 lines/, 'no bash line limit claim');
  assert.match(d, /default 60, maximum 60/i);
  assert.match(d, /0 falls back to the default/i);
  assert.match(d, /Negative values are not validated/i);
  const timeoutDesc = t.parameters?.properties?.timeout?.description ?? '';
  assert.match(timeoutDesc, /maximum 60/i);
  assert.match(timeoutDesc, /not validated/i);
});

test('resolve: description and guideline both best-effort; no logged claim; rolledBack attempted-count', () => {
  const t = byName('resolve');
  const g = (t.guidelines ?? []).join(' ');
  assert.match(t.description, /best-effort/i);
  assert.match(t.description, /non-transactional/i);
  assert.match(g, /best-effort restoration/i);
  assert.match(g, /rolledBack/i);
  assert.match(g, /not verified successes/i);
  assert.doesNotMatch(allText(t), /logged/i, 'no rollback-logged claim');
  assert.doesNotMatch(allText(t), /two-phase commit/i);
});

test('plan: recommended shape vs runtime minimum; no hard max; recommended-count normalized', () => {
  const t = byName('plan');
  const d = t.description;
  assert.match(d, /2-5/i);
  assert.match(d, /at least 2 usable steps/i);
  assert.match(d, /no maximum/i);
  assert.match(d, /normalizes?/i, 'recommended-count normalization noted');
  assert.match(t.snippet, /explicit strategy decomposition/i);
  assert.match(t.guidelines[0], /interactive confirmation callback/i);
  assert.match(t.guidelines[0], /auto-accepted/i);
  assert.match(t.guidelines[3], /recommended strategies auto-accepted/i);
  assert.match(t.guidelines[4], /interactive.*confirmation interface/i);
  assert.doesNotMatch(t.guidelines[0], /ONLY.*interactive plan/i);
  assert.match(d, /\{ confirmed:true, plan \}/i);
  assert.match(d, /autoAccepted:true/i);
});

test('plan_step: top description, guidelines, and step param all current-step semantics', () => {
  const t = byName('plan_step');
  const g = (t.guidelines ?? []).join(' ');
  const stepDesc = t.parameters?.properties?.step?.description ?? '';
  for (const text of [t.description, g, stepDesc]) {
    assert.match(text, /current/i);
  }
  assert.match(stepDesc, /compatibility\/reporting hint/i);
  assert.match(t.description, /reporting hint.*ignored/i, 'step remains a reporting hint');
  assert.match(t.description, /without a progress callback.*no progress state/i);
  assert.doesNotMatch(stepDesc, /mark done/i, 'param must not claim step selection');
  assert.match(t.guidelines[0], /interactive mode.*without a progress callback/i);
  assert.match(t.guidelines[1], /Without that callback.*no current-step mutation/i);
  assert.match(t.guidelines[3], /In interactive mode.*without a progress callback/i);
  assert.doesNotMatch(t.guidelines[1], /^Each call advances the CURRENT/i);
});

test('kb_search: conditional LLM rewrite; precise top_k budget semantics', () => {
  const t = byName('kb_search');
  const text = allText(t);
  assert.match(text, /When an LLM is attached and skip_rewrite is not true/i);
  const topDesc = t.parameters?.properties?.top_k?.description ?? '';
  assert.match(topDesc, /default to 10/i);
  assert.match(topDesc, /5-50/i);
  assert.match(topDesc, /falsy values including 0/i);
  assert.match(topDesc, /actual results may be fewer/i);
  assert.doesNotMatch(topDesc, /at least 5/i);
});

test('kb_callchain: BFS, per-direction budget, max_nodes caveat', () => {
  const d = byName('kb_callchain').description;
  assert.match(d, /BFS|breadth-first/i);
  assert.doesNotMatch(d, /DFS|depth-first/i);
  assert.match(d, /INDEPENDENTLY|independently/i);
  assert.match(d, /max_nodes - 1/i);
  const mn = byName('kb_callchain').parameters?.properties?.max_nodes?.description ?? '';
  assert.match(mn, /not validated/i, '0/1/negative caveat present in the param');
});

test('kb_neighbors: outgoing, no direction parameter', () => {
  const d = byName('kb_neighbors').description;
  assert.match(d, /OUTGOING|outgoing/i);
  assert.match(d, /no direction parameter/i);
});

test('kb_refs: direct/one-hop relations, not transitive', () => {
  const d = byName('kb_refs').description;
  assert.match(d, /DIRECT|direct/i);
  assert.match(d, /depth 1|one-hop/i);
  assert.match(d, /not a transitive closure/i);
});

test('kb_class: enum included; qual_name exact vs name substring', () => {
  const d = byName('kb_class').description;
  assert.match(d, /enum/i);
  assert.match(d, /qualified-name lookup|qual_name.*exact|exact qualified/i);
  assert.match(d, /substring/i);
  assert.match(d, /first/i, 'first-candidate match noted');
});

test('kb_implements: direct, not transitive', () => {
  const d = byName('kb_implements').description;
  assert.match(d, /DIRECT|direct/i);
  assert.match(d, /transitive/i);
});

test('find/grep: no .gitignore claim; walker note', () => {
  for (const n of ['find', 'grep']) {
    const t = byName(n);
    assert.doesNotMatch(allText(t), /respects\s+\.gitignore/i);
    assert.match(t.snippet, /skips \.git and node_modules/);
  }
});

test('kb_save_knowledge: hot reload with per-run cache caveat', () => {
  const d = byName('kb_save_knowledge').description;
  assert.match(d, /Reloads|reloads/i);
  assert.match(d, /cached result/i);
  assert.match(d, /runLoop/i);
});

test('system prompt: conditional prefetch, hint buckets, plan_step backstop, permission causes, remember success-gating, summary ids', async () => {
  const prompt = buildSystemPrompt({
    project: { name: 'p' },
    tools: [],
    permissionSummary: 'sandbox on',
  });
  assert.match(prompt, /When a "Knowledge-base context" block is present/i, 'prefetch is conditional');
  assert.match(prompt, /shared standalone-search bucket/i, 'hint buckets described');
  assert.match(prompt, /normal turn end finalizes any leftover panel/i, 'plan_step backstop described');
  assert.match(prompt, /restricted inside them/i, 'permission causes include in-project rules');
  assert.match(prompt, /reports successful persistence/i, 'remember gated on success');
  assert.match(prompt, /architecture-diagram/, 'architecture-diagram present');
  assert.match(prompt, /architecture-decisions/, 'architecture-decisions present');
  const initSummary = prompt.slice(
    prompt.lastIndexOf('three Eden', prompt.indexOf('architecture-diagram')),
    prompt.indexOf('architecture-decisions') + 40,
  );
  assert.doesNotMatch(initSummary, /api-docs/, 'api-docs must not be a /kb init summary');
  assert.match(prompt, /offer, or automatically run/i, 'kb update offer/auto line');
  assert.match(prompt, /doc: entries/i, 'doc: sync disclosed in the prompt');
  assert.match(prompt, /without a confirmation callback.*auto-accepted/i);
  assert.match(prompt, /without an interactive progress callback.*does not maintain progress state/i);
  assert.doesNotMatch(prompt, /planning interrupts the user, so/i);
});


test('plan runtime accepts minimums without a maximum and normalizes recommended flags', async () => {
  const plan = byName('plan');
  const strategies = Array.from({ length: 5 }, (_, i) => ({
    name: `strategy-${i + 1}`,
    description: 'candidate',
    ...(i < 2 ? { recommended: true } : {}),
  }));
  const steps = Array.from({ length: 6 }, (_, i) => ({
    goal: `goal-${i + 1}`,
    strategies,
  }));
  const result = await plan.execute({ steps });
  assert.equal(result.confirmed, true, 'six steps/five strategies are not hard-rejected');
  assert.match(result.plan, /Step 1: goal-1 -> strategy-1/);
  assert.match(result.plan, /Step 6: goal-6 -> strategy-1/);
  const noSummary = await plan.execute({ steps: steps.slice(0, 2) });
  assert.equal(noSummary.confirmed, true, 'missing summary normalizes to empty text');

  const invalid = await plan.execute({ steps: [{ goal: 'only-one', strategies }] });
  assert.match(invalid.error, /at least 2 usable steps/i);
  assert.doesNotMatch(invalid.error, /2-4|exactly one recommended|summary string/i);
});

test('plan schema marks step and strategy counts as recommended shape', () => {
  const t = byName('plan');
  const steps = t.parameters.properties.steps;
  const strategies = steps.items.properties.strategies;
  assert.match(steps.description, /Recommended shape.*2-5/i);
  assert.match(steps.description, /no maximum/i);
  assert.match(strategies.description, /Recommended shape.*2-4/i);
  assert.match(strategies.description, /no maximum/i);
});

test('remember failure is explicit when persistence callback is absent', async () => {
  const noPersistence = buildTools({}, { projectId: 'p-test' });
  const remember = noPersistence.find(t => t.name === 'remember');
  assert.ok(remember);
  const result = await remember.execute({ fact: 'staging endpoint 192.0.2.10' });
  assert.equal(result.ok, false);
  assert.match(remember.description, /After successful persistence/i);
  assert.doesNotMatch(`${remember.snippet} ${remember.description}`, /10\.1\.2\.3/);
});

test('remember examples use documentation-only addresses, never RFC1918 ranges', () => {
  const tools = buildTools({}, { projectId: 'p-test' });
  const remember = tools.find(t => t.name === 'remember');
  assert.ok(remember);
  const surfaces = [remember.snippet, remember.description,
    ...(remember.guidelines ?? []),
    remember.parameters?.properties?.fact?.description].filter(Boolean).join('\n');
  // No private-network examples anywhere in the model-visible text…
  assert.doesNotMatch(surfaces, /\b10\.\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(surfaces, /192\.168\./);
  assert.doesNotMatch(surfaces, /172\.(1[6-9]|2[0-9]|3[01])\./);
  // …documentation ranges (RFC 5737) instead.
  assert.match(surfaces, /192\.0\.2\.\d+/);
});

test('kb_outline and system prompt distinguish source-content reads and rewrite conditions', () => {
  const outline = byName('kb_outline');
  assert.match(outline.description, /no source-content read/i);
  assert.match(outline.description, /Filesystem metadata/i);
  assert.match(outline.description, /does not use SOURCE_EXT_RE/i);
  const prompt = buildSystemPrompt({ project: { name: 'p' }, tools: [] });
  assert.match(prompt, /When an LLM is attached and skip_rewrite is not true/);
  assert.match(prompt, /no source-content read/);
  assert.match(prompt, /reporting hint/);
});

test('concept docs keep /kb search separate from Agent kb_search', () => {
  for (const lang of ['en', 'zh-CN']) {
    const doc = readFileSync(new URL(`../docs/${lang}/concepts/knowledge-graph-and-retrieval.md`, import.meta.url), 'utf8');
    const table = doc.slice(doc.indexOf('## BM25'), doc.indexOf('## ', doc.indexOf('## BM25') + 5));
    assert.match(table, /\/kb search/);
    assert.match(table, /20/);
    assert.match(table, /Agent `kb_search`/);
    assert.match(table, /5.?50/);
    assert.doesNotMatch(table, /\/kb search.*rewrite.*default/i);
  }
});

test('plan schema requires summary and steps for model-visible calls', () => {
  assert.deepEqual(byName('plan').parameters.required, ['summary', 'steps']);
});

test('grep uses regex by default and literal mode only when requested', async () => {
  const grep = byName('grep');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { resetPermissionService } = await import('../lib/config/setting.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'hk2-tool-desc-'));
  await writeFile(join(dir, 'x.txt'), 'a.b\naXb\n');
  const previousRoot = process.env.HK2_PROJECT_SOURCE;
  process.env.HK2_PROJECT_SOURCE = dir;
  resetPermissionService();
  const regex = await grep.execute({ pattern: 'a.b', path: join(dir, 'x.txt') });
  const literal = await grep.execute({ pattern: 'a.b', literal: true, path: join(dir, 'x.txt') });
  assert.equal(regex.count, 2);
  assert.equal(literal.count, 1);
  assert.doesNotMatch(allText(grep), /literal text only/i);
  if (previousRoot === undefined) delete process.env.HK2_PROJECT_SOURCE;
  else process.env.HK2_PROJECT_SOURCE = previousRoot;
  resetPermissionService();
  await rm(dir, { recursive: true, force: true });
});

test('KbFirstGuard callers, update mode, extension scope, and LLM-call scope are accurate', () => {
  const guard = new KbFirstGuard();
  const read = guard.readHint('/tmp/example.md');
  assert.match(read, /source or documentation file/i);
  assert.match(read, /kb_callchain\(direction="backward" or "both"\)|kb_refs\(kind="call"\)/i);
  assert.doesNotMatch(read, /callers via kb_neighbors/i);
  assert.match(read, /once per LLM call/i);
  const bash = guard.bashHint('grep -R login src');
  assert.match(bash, /offer or automatically run.*HK2_ENABLE_AUTOUPDATEKB/i);
  assert.doesNotMatch(bash, /faster \+ more accurate/i);
  const ast = byName('ast_grep');
  assert.match(ast.parameters.properties.path.description, /directory OR single file/i);
});

test('ast_grep accepts a single-file path as well as a directory root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hk2-ast-single-'));
  const file = path.join(dir, 'sample.js');
  await writeFile(file, 'const answer = 42;\n');
  const previousRoot = process.env.HK2_PROJECT_SOURCE;
  process.env.HK2_PROJECT_SOURCE = dir;
  resetPermissionService();
  try {
    const ast = buildTools(null, {}).find(t => t.name === 'ast_grep');
    const result = await ast.execute({ pat: 'const $NAME = $$$VALUE', path: file });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.ok(result.matchCount >= 1, `expected a match in ${file}: ${JSON.stringify(result)}`);
    assert.match(result.matches[0].text, /const answer =/);
  } finally {
    if (previousRoot === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = previousRoot;
    resetPermissionService();
    await rm(dir, { recursive: true, force: true });
  }
});

test('kb_search top_k uses a ten-result falsy default, 5-50 normalization, and short-match results', async () => {
  const symbols = Array.from({ length: 60 }, (_, i) => ({
    id: `file.js:${i + 1}`,
    name: `needle${i}`,
    kind: 'function',
    fileId: 'file.js',
    lineStart: i + 1,
    lineEnd: i + 1,
    signature: 'needle()',
    body: 'needle();',
  }));
  const rt = {
    bm: { query: () => symbols.map(s => ({ symbolId: s.id, score: 1 })) },
    getSymbolById: id => symbols.find(s => s.id === id),
    getFilePath: () => 'file.js',
    callgraph: { byId: {} },
  };
  const search = buildTools(rt, {}).find(t => t.name === 'kb_search');
  assert.equal((await search.execute({ query: 'needle', top_k: 0, with_slice: false })).results.length, 10);
  assert.equal((await search.execute({ query: 'needle', top_k: -1, with_slice: false })).results.length, 5);
  assert.equal((await search.execute({ query: 'needle', top_k: 100, with_slice: false })).results.length, 50);
  const shortRt = { ...rt, bm: { query: () => symbols.slice(0, 2).map(s => ({ symbolId: s.id, score: 1 })) } };
  const short = buildTools(shortRt, {}).find(t => t.name === 'kb_search');
  assert.equal((await short.execute({ query: 'needle', top_k: 100, with_slice: false })).results.length, 2);
});
