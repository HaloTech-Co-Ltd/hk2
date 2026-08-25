/*-------------------------------------------------------------------------
 *
 * Unit + integration tests for deep document parsing & knowledge extraction:
 *   - extractMarkdownLinks / extractMarkdownTables / extractCodeBlocks
 *   - buildDocGraph (links / tables / symbol mentions)
 *   - buildIndex integration: doc_index.json written, doc: Eden entries
 *     enriched with keySymbols + table-header keywords
 *   - KBRuntime doc APIs: findTables / getSymbolDocRefs / referencedBy
 *   - buildRequestGraph injection: docTables + docSymbolRefs present
 *
 * Run:  node --test test/doc_deep_parse.test.js
 * ----------------------------------------------------------------------*/

// MUST be the first import: isolates HK2_HOME so the project store + KB root
// are per-test-run temp dirs.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  parseMarkdown,
  parseHtml,
  extractMarkdownLinks,
  extractMarkdownTables,
  extractCodeBlocks,
} from '../lib/parser/doc_parser.js';
import { buildDocGraph } from '../lib/index/doc_graph.js';
import { proseIdentifiers } from '../lib/index/doc_graph.js';
import { buildIndex } from '../lib/index/indexer.js';
import { addKbForProject } from '../lib/index/registry.js';
import { sha256 } from '../lib/util/hash.js';
import * as home from '../lib/config/home.js';
import { readDocIndex } from '../lib/store/doc_index_store.js';
import { findKnowledge, listKnowledge } from '../lib/store/kb_store.js';

/* ------------------- pure extractor unit tests ------------------------- */

test('extractMarkdownLinks: inline, reference-style, wiki links; skips code', () => {
  const src = [
    '# Title',
    'See [setup guide](setup.md) and [config](docs/config.md#section-1).',
    'External [site](https://example.com) ignored by buildDocGraph but still extracted.',
    'Ref-style [advanced][adv] and collapsed [ref][].',
    '[adv]: advanced.md "Advanced guide"',
    '[ref]: reference.md',
    'Wiki [[Glossary]] and [[Design|the design doc]].',
    '```js',
    'const x = "[not a link](nope.md)";',
    '```',
    'Inline `code [skip](skip.md)` is ignored.',
  ].join('\n');

  const links = extractMarkdownLinks(src);
  const targets = links.map(l => l.target);

  assert.ok(targets.includes('setup.md'), 'inline link target');
  assert.ok(targets.includes('docs/config.md#section-1'), 'link with anchor');
  const cfg = links.find(l => l.target === 'docs/config.md#section-1');
  assert.equal(cfg.anchor, 'section-1');
  assert.ok(targets.includes('https://example.com'), 'external link extracted');
  assert.ok(targets.includes('advanced.md'), 'reference-style definition resolved');
  assert.ok(targets.includes('reference.md'), 'collapsed reference resolved');
  assert.ok(targets.includes('Glossary'), 'wiki link');
  assert.ok(!targets.includes('nope.md'), 'link inside fenced code skipped');
  assert.ok(!targets.includes('skip.md'), 'link inside inline code skipped');
});

test('extractMarkdownTables: GFM tables with alignment, nearest heading title', () => {
  const src = [
    '# Config',
    '',
    'Intro paragraph.',
    '',
    '## Parameters',
    '',
    '| Name | Type | Default | Description |',
    '|------|------|--------:|-------------|',
    '| `port` | int | 5432 | Listen port |',
    '| host | string | localhost | Bind address |',
    '',
    'Some text between.',
    '',
    '## No table here',
  ].join('\n');

  const tables = extractMarkdownTables(src);
  assert.equal(tables.length, 1);
  const t = tables[0];
  assert.equal(t.title, 'Parameters');
  assert.deepEqual(t.headers, ['Name', 'Type', 'Default', 'Description']);
  assert.equal(t.align[2], 'right');
  assert.equal(t.align[0], null);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0][0], '`port`');
  // escaped pipe inside a cell
  const tricky = extractMarkdownTables([
    '| a | b \\| c |',
    '|---|--------|',
    '| 1 | 2 \\| 3 |',
  ].join('\n'));
  assert.equal(tricky[0].rows[0][1], '2 | 3');
});

test('extractCodeBlocks: fenced blocks with language, unclosed ignored', () => {
  const src = [
    'text',
    '```js',
    'const a = 1;',
    '```',
    '~~~~python',
    'def f(): pass',
    '~~~~',
    '```text',
    'never closed',
  ].join('\n');
  const blocks = extractCodeBlocks(src);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].lang, 'js');
  assert.equal(blocks[0].code, 'const a = 1;');
  assert.equal(blocks[1].lang, 'python');
});

/* --------------------- entity decoding regression ------------------------ */

test('parseHtml decodes named AND numeric HTML entities in text and sections', () => {
  // Regression: the decode regex was &[a-z]+; which never matched numeric
  // entities like &#39; — the HTML_ENTITY mapping key was dead in the HTML path.
  const out = parseHtml(
    '<html><title>A&amp;B</title><body><h1>Head&#39;s up</h1>'
    + '<p>a &amp; b &lt;c&gt; &quot;q&quot; x&nbsp;y &copy;2026 &#39;quoted&#39;</p></body></html>',
    't.html');
  assert.equal(out.title, 'A&B');
  assert.equal(out.sections[0].title, "Head's up");
  // `text` is the whole-document flattening (title + headings + body)
  assert.equal(out.text, "A&B Head's up a & b <c> \"q\" x y ©2026 'quoted'");
});

test('parseMarkdown: backward-compatible flat shape + deep fields attached', () => {
  const out = parseMarkdown([
    '# Doc',
    '',
    '[other](other.md)',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'foo();',
    '```',
  ].join('\n'), 'doc.md');

  assert.equal(out.kind, 'doc');
  assert.equal(out.title, 'Doc');
  assert.ok(Array.isArray(out.sections) && out.sections.length > 0);
  assert.equal(out.links.length, 1);
  assert.equal(out.tables.length, 1);
  assert.equal(out.codeBlocks.length, 1);

  // A doc without any structure gets NO extra fields at all
  const plain = parseMarkdown('# Only heading\n\nbody\n', 'plain.md');
  assert.equal('links' in plain, false);
  assert.equal('tables' in plain, false);
  assert.equal('codeBlocks' in plain, false);
});

/* ------------------------- buildDocGraph tests ------------------------- */

/* --------------------- prose-mention truncation regression ---------------- */

test('prose mentions survive the 20k _docInputs text cap via persisted proseIdents', () => {
  // Regression: the indexer truncates stored _docInputs text at 20k chars.
  // Prose symbol mentions located past the cap used to vanish on incremental
  // rebuilds (merged inputs re-scanned the truncated text). proseIdents —
  // precomputed from the FULL text — must keep them alive.
  const bigText = 'intro usesHeadFn().\n' + 'x'.repeat(25000) + ' tail mentions usesTailFn() too.';

  // Full-text scan (first build) sees both.
  const full = buildDocGraph({
    docs: [{ path: 'big.md', links: [], tables: [], codeBlocks: [], text: bigText }],
    symbolNames: ['usesHeadFn', 'usesTailFn'],
  });
  assert.ok(full.symbolMentions.usesHeadFn, 'head mention (full text)');
  assert.ok(full.symbolMentions.usesTailFn, 'tail mention (full text)');

  // Truncated round-trip WITH proseIdents (what the indexer now persists).
  const persisted = {
    path: 'big.md',
    links: [], tables: [], codeBlocks: [],
    text: bigText.slice(0, 20000),
    proseIdents: proseIdentifiers(bigText),
  };
  const after = buildDocGraph({ docs: [persisted], symbolNames: ['usesHeadFn', 'usesTailFn'] });
  assert.ok(after.symbolMentions.usesHeadFn, 'head mention survives truncation');
  assert.ok(after.symbolMentions.usesTailFn, 'tail mention survives truncation via proseIdents');
});

test('buildDocGraph: resolves cross refs, indexes tables, associates symbols', () => {
  const docs = [
    {
      path: 'docs/index.md',
      links: [
        { text: 'setup', target: 'setup.md' },
        { text: 'nested', target: './guides/nested.md' },
        { text: 'ext', target: 'https://example.com' },
        { text: 'self', target: 'docs/index.md' },
        { text: 'missing', target: 'nope.md' },
      ],
      tables: [],
      codeBlocks: [],
      text: 'plain intro',
    },
    {
      path: 'docs/setup.md',
      links: [{ text: 'root readme', target: '../index.md' }],
      tables: [{
        title: 'Parameters',
        headers: ['Name', 'Default'],
        align: [null, 'right'],
        rows: [['port', '5432']],
      }],
      codeBlocks: [{ lang: 'js', code: 'parseMarkdown(); helper();' }],
      text: 'setup mentions parseMarkdown and helperFn in prose',
    },
    {
      path: 'docs/guides/nested.md',
      links: [{ text: 'home', target: '../../index.md' }],
      tables: [],
      codeBlocks: [],
      text: 'nested guide',
    },
    {
      path: 'index.md',
      links: [],
      tables: [],
      codeBlocks: [],
      text: 'root entry',
    },
  ];
  const idx = buildDocGraph({
    docs,
    symbolNames: ['parseMarkdown', 'helperFn', 'helper'],
  });

  // links: index→setup, index→nested, setup→root index, nested→root index
  // (external / self / missing targets dropped)
  const pairs = idx.links.map(l => `${l.from} -> ${l.to}`).sort();
  assert.ok(pairs.includes('docs/index.md -> docs/setup.md'));
  assert.ok(pairs.includes('docs/index.md -> docs/guides/nested.md'));
  assert.ok(pairs.includes('docs/setup.md -> index.md'), '../ normalization');
  assert.ok(pairs.includes('docs/guides/nested.md -> index.md'), '../../ normalization');
  assert.equal(idx.links.length, 4);

  // referencedBy reverse index
  assert.deepEqual(idx.referencedBy['docs/setup.md'], ['docs/index.md']);
  assert.deepEqual([...idx.referencedBy['index.md']].sort(), ['docs/guides/nested.md', 'docs/setup.md']);

  // tables
  assert.equal(idx.tables.length, 1);
  assert.equal(idx.tables[0].doc, 'docs/setup.md');
  assert.deepEqual(idx.tables[0].headers, ['Name', 'Default']);

  // symbol mentions: code mention from codeBlock, prose mention from text
  assert.ok(idx.symbolMentions.parseMarkdown.some(m => m.doc === 'docs/setup.md' && m.kind === 'code'));
  assert.ok(idx.symbolMentions.helper.some(m => m.kind === 'code'));
  assert.ok(idx.symbolMentions.helperFn.some(m => m.kind === 'prose'));
  assert.ok(!idx.symbolMentions.helperFn.some(m => m.kind === 'code'));

  // doc records
  assert.equal(idx.docs['docs/index.md'].linkCount, 2);
  assert.equal(idx.docs['docs/setup.md'].tableCount, 1);

  // referencedBy backfill is ORDER-INDEPENDENT: every doc here is processed
  // BEFORE its referrer except root index.md (last) — the per-record copies
  // must still reflect the complete reverse-reference lists.
  assert.deepEqual([...idx.docs['index.md'].referencedBy].sort(), ['docs/guides/nested.md', 'docs/setup.md']);
  assert.deepEqual(idx.docs['docs/setup.md'].referencedBy, ['docs/index.md']);
  assert.deepEqual(idx.docs['docs/guides/nested.md'].referencedBy, ['docs/index.md']);
  // A doc with no inbound links gets an empty (not missing) array
  assert.deepEqual(idx.docs['docs/index.md'].referencedBy, []);

  assert.equal(idx.meta.linkCount, 4);
  assert.equal(idx.meta.tableCount, 1);
  assert.equal(idx.meta.docCount, 4);
});

/* --------------------- include-glob sync regression --------------------- */

test('default include globs cover sgml/pdf/office docs; legacy 40-glob projects self-heal on /kb init', async () => {
  const { DEFAULT_INCLUDE_GLOBS } = await import('../lib/config/home.js');
  for (const g of ['**/*.sgml', '**/*.pdf', '**/*.doc', '**/*.docx', '**/*.ppt', '**/*.pptx']) {
    assert.ok(DEFAULT_INCLUDE_GLOBS.includes(g), `DEFAULT_INCLUDE_GLOBS missing ${g}`);
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-glob-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs', 'z.sgml'),
    '<chapter><title>T</title><para>uses parseMarkdown</para></chapter>');

  // Legacy project: includeGlobs frozen at the OLD 40-glob default (no doc
  // formats). addKbForProject must upgrade it to the current default.
  const OLD_40 = [
    '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.cxx',
    '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
    '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.scala',
    '**/*.rb', '**/*.php', '**/*.swift',
    '**/*.sh', '**/*.bash', '**/*.zsh',
    '**/*.y', '**/*.l',
    '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
    '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*',
    '**/*.json', '**/*.yaml', '**/*.yml', '**/*.html', '**/*.htm',
  ];
  const p = await home.registerProject({ sourcePath: dir, name: 'glob-legacy', includeGlobs: OLD_40 });
  await addKbForProject(p);
  const after = await home.getProject(p.id);
  assert.ok(after.includeGlobs.includes('**/*.sgml'), 'legacy includeGlobs upgraded');
  assert.equal(after.includeGlobs.length, DEFAULT_INCLUDE_GLOBS.length, 'upgraded to full default');

  // Custom globs are NEVER touched.
  const p2 = await home.registerProject({ sourcePath: dir, name: 'glob-custom', includeGlobs: ['**/*.js'] });
  await addKbForProject(p2);
  const after2 = await home.getProject(p2.id);
  assert.deepEqual(after2.includeGlobs, ['**/*.js'], 'custom includeGlobs untouched');

  // And the sgml file actually enters the doc index.
  await buildIndex(p.id, { skipSummary: true });
  const idx = await readDocIndex(p.id);
  assert.ok(idx.docs['docs/z.sgml'], 'sgml doc present in doc index');
});

/* --------------------- single-column GFM tables ------------------------- */

test('extractMarkdownTables: single-column table recognized; delimiter mismatch rejected', () => {
  const single = [
    '## Steps',
    '',
    '| Phase |',
    '| --- |',
    '| init |',
    '| run |',
  ].join('\n');
  const tables = extractMarkdownTables(single);
  assert.equal(tables.length, 1, 'single-column table extracted');
  assert.deepEqual(tables[0].headers, ['Phase']);
  assert.equal(tables[0].title, 'Steps');
  assert.deepEqual(tables[0].rows, [['init'], ['run']]);

  // Delimiter row with a DIFFERENT cell count than the header is not a table
  // (setext-underline / hr false positive).
  const mismatch = [
    '| a | b |',
    '| --- |',
    '| 1 | 2 |',
  ].join('\n');
  assert.equal(extractMarkdownTables(mismatch).length, 0, 'cell-count mismatch rejected');
});

/* --------------------- buildIndex integration test ---------------------- */

async function makeProject(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-deep-'));
  for (const [rel, content] of Object.entries(files)) {
    const fp = path.join(dir, rel);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content);
  }
  const p = await home.registerProject({
    sourcePath: dir,
    name: 'doc-deep-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  });
  await home.setCurrentProject(p.id);
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });
  return { dir, p };
}

test('buildIndex writes doc_index.json and enriches doc: Eden entries', async () => {
  const GUIDE = [
    '# Guide',
    '',
    'Read the [reference](reference.md) first.',
    '',
    '## Server parameters',
    '',
    '| Name | Default | Description |',
    '|------|---------|-------------|', 
    '| maxConnections | 100 | Maximum concurrent connections |',
    '| port | 5432 | TCP listen port |',
    '',
    '```js',
    'import { serve } from "./server.js";',
    'serve({ port: 5432 });',
    '```',
  ].join('\n');

  const { dir, p } = await makeProject({
    'docs/guide.md': GUIDE,
    'docs/reference.md': '# Reference\n\nSee the [guide](guide.md).\n',
    'src/server.js': 'export function serve(opts) { return opts; }\nexport function stop() {}\n',
  });
  try {
    const idx = await readDocIndex(p.id);
    assert.ok(idx, 'doc_index.json exists');

    // Cross refs both directions
    const pairs = idx.links.map(l => `${l.from} -> ${l.to}`);
    assert.ok(pairs.includes('docs/guide.md -> docs/reference.md'));
    assert.ok(pairs.includes('docs/reference.md -> docs/guide.md'));

    // Table indexed with headers
    assert.equal(idx.tables.length, 1);
    assert.equal(idx.tables[0].doc, 'docs/guide.md');
    assert.deepEqual(idx.tables[0].headers, ['Name', 'Default', 'Description']);

    // Symbol mentions: serve() from the code block
    assert.ok(idx.symbolMentions.serve?.some(m => m.doc === 'docs/guide.md' && m.kind === 'code'));

    // Eden entry enrichment
    const found = await findKnowledge(p.id, 'doc:docs/guide.md');
    assert.ok(found, 'doc:docs/guide.md eden entry exists');
    assert.ok(found.entry.keySymbols.includes('serve'), `keySymbols includes serve, got ${found.entry.keySymbols}`);
    assert.ok(found.entry.keywords.includes('maxconnections'), 'table header keyword indexed');
    assert.ok(Array.isArray(found.entry.docRefs) && found.entry.docRefs.includes('docs/reference.md'), 'docRefs backfilled');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('incremental rebuild keeps untouched docs via _docInputs merge', async () => {
  const { dir, p } = await makeProject({
    'docs/a.md': '# A\n\nSee [b](b.md).\n\n| Param | Val |\n|---|---|\n| timeout | 30 |\n\n```js\nrunAll();\n```\n',
    'docs/b.md': '# B\n\nBack to [a](a.md).\n',
    'src/core.js': 'export function runAll() {}\n',
  });
  try {
    const before = await readDocIndex(p.id);
    assert.equal(before.meta.linkCount, 2);
    assert.equal(before.meta.tableCount, 1);

    // Touch ONLY b.md; a.md is unchanged and must survive via the merge
    await new Promise(r => setTimeout(r, 1100));   // ensure mtime/hash differ
    await fs.writeFile(path.join(dir, 'docs/b.md'), '# B2\n\nBack to [a](a.md) and new [c](c.md).\n');
    await fs.writeFile(path.join(dir, 'docs/c.md'), '# C\n');
    await buildIndex(p.id, { skipSummary: true });

    const after = await readDocIndex(p.id);
    assert.equal(after.meta.tableCount, 1, 'a.md table survives incremental rebuild');
    assert.ok(after.symbolMentions.runAll?.some(m => m.doc === 'docs/a.md'), 'a.md symbol mention survives');
    assert.ok(after.links.some(l => l.from === 'docs/a.md' && l.to === 'docs/b.md'));
    assert.ok(after.links.some(l => l.from === 'docs/b.md' && l.to === 'docs/c.md'), 'new b→c link indexed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- upgrade path regression --------------------------- */

test('pre-doc-graph KB upgrading via incremental build keeps its doc: eden entries and builds the doc graph', async () => {
  // Regression: an old KB (built before the doc graph feature) has doc: Eden
  // entries but NO doc_index.json. Its first incremental rebuild with the new
  // code re-parses nothing (hashes match), so the doc graph came up empty and
  // the stale-entry cleanup MASS-DELETED every doc: entry. The indexer must
  // detect the missing doc_index.json and force deep-parse the unchanged docs.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-upgrade-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.js'), 'export function alpha() { return 1; }\n');
  await fs.writeFile(path.join(dir, 'docs', 'guide.md'),
    '# Guide\n\nSee the [ref](ref.md).\n\n| Param | Default |\n|---|---|\n| port | 8080 |\n\n```js\nalpha();\n```\n');
  await fs.writeFile(path.join(dir, 'docs', 'ref.md'), '# Ref\n\nUses alpha().\n');

  const p = await home.registerProject({ sourcePath: dir, name: 'doc-upgrade' });
  await home.setCurrentProject(p.id);
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });
  assert.ok(await readDocIndex(p.id), 'initial doc_index.json written');

  // Simulate the PRE-FEATURE state: eden doc: entries exist, doc_index.json absent.
  const kbDir = path.join(process.env.HK2_HOME, 'kb', p.id);
  await fs.rm(path.join(kbDir, 'doc_index.json'));

  // Incremental rebuild — nothing changed on disk.
  const st = await buildIndex(p.id, { skipSummary: true });
  try {
    const idx = await readDocIndex(p.id);
    assert.ok(idx, 'doc_index.json rebuilt');
    assert.equal(idx.meta.docCount, 2, `expected 2 docs, got ${idx.meta.docCount}`);
    assert.equal(idx.meta.linkCount, 1, 'guide -> ref link resolved');
    assert.equal(idx.meta.tableCount, 1, 'guide table indexed');
    assert.ok(idx.symbolMentions.alpha?.length, 'alpha mentioned in docs');

    const eden = await listKnowledge(p.id, 'eden');
    const ids = eden.filter(e => e.id.startsWith('doc:')).map(e => e.id).sort();
    assert.deepEqual(ids, ['doc:docs/guide.md', 'doc:docs/ref.md'],
      `doc: entries must survive the upgrade rebuild, got ${JSON.stringify(ids)}`);
    assert.equal(st.totalDocs, 2, 'stats.totalDocs counts upgraded docs');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('upgrade rescue also covers docs skipped by a leftover checkpoint (interrupted upgrade run)', async () => {
  // Regression: the skippedTrackedDocs rescue used to live ONLY on the
  // "hash unchanged" branch. A checkpoint left behind by an interrupted run
  // short-circuits earlier (cp.has() → continue), so docs processed in the
  // previous run were never deep-parsed — doc graph came up empty and the
  // stale-entry cleanup mass-deleted every doc: Eden entry.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-upgrade-cp-'));
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'a.js'), 'export function alpha() { return 1; }\n');
  await fs.writeFile(path.join(dir, 'docs', 'guide.md'),
    '# Guide\n\nSee the [ref](ref.md).\n\n| Param | Default |\n|---|---|\n| port | 8080 |\n\n```js\nalpha();\n```\n');
  await fs.writeFile(path.join(dir, 'docs', 'ref.md'), '# Ref\n\nUses alpha().\n');

  const p = await home.registerProject({ sourcePath: dir, name: 'doc-upgrade-cp' });
  await home.setCurrentProject(p.id);
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });

  // Simulate the pre-feature state + a checkpoint from a killed upgrade run:
  // doc_index.json deleted, checkpoint claims all files were processed.
  const kbDir = path.join(process.env.HK2_HOME, 'kb', p.id);
  await fs.rm(path.join(kbDir, 'doc_index.json'));
  const hashOf = async (rel) => sha256(await fs.readFile(path.join(dir, rel), 'utf8'));
  await fs.writeFile(path.join(kbDir, 'checkpoint.json'), JSON.stringify({
    phase: 'parse',
    processedFiles: [
      { path: 'a.js', hash: await hashOf('a.js') },
      { path: 'docs/guide.md', hash: await hashOf('docs/guide.md') },
      { path: 'docs/ref.md', hash: await hashOf('docs/ref.md') },
    ],
    lastSavedAt: new Date().toISOString(),
    interval: 100,
  }));

  await buildIndex(p.id, { skipSummary: true });
  try {
    const idx = await readDocIndex(p.id);
    assert.equal(idx.meta.docCount, 2, `expected 2 docs, got ${idx.meta.docCount}`);
    assert.equal(idx.meta.linkCount, 1, 'guide -> ref link resolved');
    assert.equal(idx.meta.tableCount, 1, 'guide table indexed');
    assert.ok(idx.symbolMentions.alpha?.length, 'alpha mentioned in docs');

    const eden = await listKnowledge(p.id, 'eden');
    const ids = eden.filter(e => e.id.startsWith('doc:')).map(e => e.id).sort();
    assert.deepEqual(ids, ['doc:docs/guide.md', 'doc:docs/ref.md'],
      `doc: entries must survive the checkpoint-resumed upgrade, got ${JSON.stringify(ids)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deleted docs drop out of doc_index.json AND their eden entries are removed', async () => {
  const { dir, p } = await makeProject({
    'docs/keep.md': '# Keep\n\n[gone](gone.md)\n',
    'docs/gone.md': '# Gone\n\n[keep](keep.md)\n',
    'src/a.js': 'export function a() {}\n',
  });
  try {
    const before = await readDocIndex(p.id);
    assert.ok(before.docs['docs/gone.md'], 'gone.md indexed initially');
    assert.ok(await findKnowledge(p.id, 'doc:docs/gone.md'), 'eden entry exists initially');

    // "Already-poisoned" regression: a PREVIOUS upgrade run (before this fix)
    // may have already emptied the doc graph — doc_index.json exists but
    // _docInputs is []. Such a KB must still self-heal, so the rescue trigger
    // is "no usable _docInputs", not merely "doc_index.json missing".
    const kbDir = path.join(process.env.HK2_HOME, 'kb', p.id);
    const poisoned = JSON.parse(await fs.readFile(path.join(kbDir, 'doc_index.json'), 'utf8'));
    poisoned._docInputs = [];
    await fs.writeFile(path.join(kbDir, 'doc_index.json'), JSON.stringify(poisoned));

    // Delete gone.md, rebuild incrementally
    await fs.rm(path.join(dir, 'docs/gone.md'));
    await buildIndex(p.id, { skipSummary: true });

    const after = await readDocIndex(p.id);
    assert.ok(!after.docs['docs/gone.md'], 'gone.md dropped from doc index');
    assert.ok(!after.links.some(l => l.from === 'docs/gone.md' || l.to === 'docs/gone.md'), 'gone.md links dropped');
    assert.equal(after.docs['docs/keep.md'].linkCount, 0, 'keep.md link to deleted doc resolves to nothing');
    const stale = await findKnowledge(p.id, 'doc:docs/gone.md');
    assert.equal(stale, null, 'stale doc: eden entry deleted');
    assert.ok(await findKnowledge(p.id, 'doc:docs/keep.md'), 'keep.md eden entry survives');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('incremental rebuild backfills proseIdents for pre-cap persisted doc inputs', async () => {
  // Regression: _docInputs persisted before the proseIdents field carry a
  // text ALREADY truncated at the 20k cap with no identifier set — tail
  // mentions are unrecoverable from the stored text. The incremental run
  // must detect this (text.length >= 20000 && no proseIdents) and re-parse
  // those docs once through the skippedTrackedDocs rescue channel.
  const bigTail = '# Big\n\nusesHeadFn().\n' + 'x'.repeat(21000) + '\ntail usesTailFn().\n';
  const { dir, p } = await makeProject({
    'docs/big.md': bigTail,
    'src/big.js': 'export function usesHeadFn() {}\nexport function usesTailFn() {}\n',
  });
  try {
    // First build: full text, both mentions recorded.
    let idx = await readDocIndex(p.id);
    assert.ok(idx.symbolMentions.usesTailFn?.some(m => m.doc === 'docs/big.md'),
      'tail mention present on first build');

    // Simulate a PRE-proseIdents persisted record: truncated text, no field.
    const kbDir = path.join(process.env.HK2_HOME, 'kb', p.id);
    const poisoned = JSON.parse(await fs.readFile(path.join(kbDir, 'doc_index.json'), 'utf8'));
    for (const d of poisoned._docInputs) delete d.proseIdents;
    await fs.writeFile(path.join(kbDir, 'doc_index.json'), JSON.stringify(poisoned));

    // Incremental rebuild — file unchanged, but the backfill must kick in.
    await buildIndex(p.id, { skipSummary: true });
    idx = await readDocIndex(p.id);
    assert.ok(idx.symbolMentions.usesTailFn?.some(m => m.doc === 'docs/big.md'),
      'tail mention restored after backfill rebuild');
    const input = (idx._docInputs || []).find(d => d.path === 'docs/big.md');
    assert.ok(Array.isArray(input?.proseIdents) && input.proseIdents.length > 0,
      'proseIdents persisted for the big doc');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('KBRuntime doc APIs: findTables / getSymbolDocRefs / referencedBy + request graph injection', async () => {
  const { dir, p } = await makeProject({
    'docs/compat.md': [
      '# Compatibility',
      '',
      '## Version matrix',
      '',
      '| Version | Protocol | Status |',
      '|---------|----------|--------|',
      '| 1.0 | v1 | supported |',
      '| 2.0 | v2 | supported |',
      '| 3.0 | v3 | deprecated |',
      '',
      'Uses `connect()` internally.',
    ].join('\n'),
    'src/net.js': 'export function connect(host) { return host; }\n',
  });
  try {
    const { getRuntime } = await import('../lib/retrieval/kb_runtime.js');
    const rt = await getRuntime(p.id);

    // findTables ranks by header/body token hits
    const hits = rt.findTables('version protocol compatibility', 3);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].headers[0], 'Version');
    // score: 3 header tokens * 2 (version/protocol/compatibility all match headers)

    // symbol doc refs
    const refs = rt.getSymbolDocRefs('connect');
    assert.ok(refs.length >= 1);
    assert.equal(refs[0].doc, 'docs/compat.md');

    // request graph injection
    const { buildRequestGraph, renderRequestGraph } = await import('../lib/agent/graph.js');
    const g = await buildRequestGraph(rt, 'connect version protocol', { project: { sourcePath: dir, sourceRoot: '' } });
    assert.ok(g.docTables.length >= 1, 'docTables injected into request graph');
    assert.ok(g.docSymbolRefs.some(r => r.symbol === 'connect'), 'connect doc-ref injected');
    const rendered = renderRequestGraph(g);
    assert.match(rendered, /## Structured doc tables/);
    assert.match(rendered, /Version \| Protocol \| Status/);
    assert.match(rendered, /## Doc ↔ code symbol references/);
    assert.match(rendered, /connect/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
