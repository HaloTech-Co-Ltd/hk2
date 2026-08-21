/*-------------------------------------------------------------------------
 *
 * Unit tests for /kb knowledge learn (src/slash/kb.js) and the document
 * parser format additions (lib/parser/doc_parser.js).
 *
 * Covers:
 *   - doc_parser: .doc / .pptx / .ppt routing + extraction
 *   - learn helpers: isLearnableExt, walkLearnFiles (recursive + unsupported),
 *     reconcilePlan (safety net so every file is learned), parseFlags
 *   - end-to-end dry-run of knowledgeLearnKb with a mock LLM + real project
 *
 * Run:  node --test test/learn_knowledge.test.js
 * ----------------------------------------------------------------------*/

// MUST be the first import: it sets HK2_HOME to a temp dir so the E2E tests
// get an isolated project store + KB root. home.js reads HK2_HOME at load.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseDocument, isDocFile } from '../lib/parser/doc_parser.js';
import { __learnTest, cmdKb } from '../src/slash/kb.js';
import * as home from '../lib/config/home.js';
import { setCurrentProject } from '../lib/config/home.js';
import { writeKnowledge, readKnowledge, listKnowledge } from '../lib/store/kb_store.js';

const { isLearnableExt, walkLearnFiles, reconcilePlan, parseFlags, LEARN_DOC_EXTS, chunkDocText, groupByBudget, labelMatches } = __learnTest;

/* ----------------------- doc_parser format support ---------------------- */

test('isDocFile recognizes all learnable document extensions', () => {
  for (const ext of ['md', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'markdown', 'sgml', 'txt']) {
    assert.equal(isDocFile(ext), true, `expected isDocFile(.${ext}) = true`);
  }
  assert.equal(isDocFile('js'), false);
  assert.equal(isDocFile('exe'), false);
});

test('LEARN_DOC_EXTS contains the user-required formats', () => {
  for (const ext of ['md', 'pdf', 'doc', 'docx', 'ppt', 'pptx']) {
    assert.ok(LEARN_DOC_EXTS.has(ext), `LEARN_DOC_EXTS missing .${ext}`);
  }
});

test('parseDocument extracts text from a .pptx (slide-by-slide)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-pptx-'));
  try {
    const slidesDir = path.join(dir, 'ppt', 'slides');
    await fs.mkdir(slidesDir, { recursive: true });
    await fs.writeFile(path.join(slidesDir, 'slide1.xml'),
      '<?xml version="1.0"?><s><a:t>Alpha topic</a:t><a:t>detail one</a:t></s>');
    await fs.writeFile(path.join(slidesDir, 'slide2.xml'),
      '<?xml version="1.0"?><s><a:t>Beta &amp; gamma</a:t></s>');
    // Build a real zip with python so the central directory is valid.
    const { execSync } = await import('node:child_process');
    execSync(`python3 -c "import zipfile; z=zipfile.ZipFile('deck.pptx','w',zipfile.ZIP_DEFLATED); z.write('ppt/slides/slide1.xml'); z.write('ppt/slides/slide2.xml'); z.close()"`, { cwd: dir });
    const parsed = await parseDocument(path.join(dir, 'deck.pptx'));
    assert.ok(parsed, 'pptx should parse');
    assert.equal(parsed.kind, 'doc');
    assert.match(parsed.text, /Alpha topic/);
    assert.match(parsed.text, /detail one/);
    assert.match(parsed.text, /Beta & gamma/); // entity decoded
    assert.equal(parsed.sections.length, 2);
    assert.equal(parsed.sections[0].title, 'Slide 1');
    assert.equal(parsed.sections[1].title, 'Slide 2');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseDocument best-effort extracts text from a legacy .doc', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-doc-'));
  try {
    // Mimic an OLE compound file: header + printable UTF-16LE-ish runs.
    const parts = [];
    parts.push(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    for (const w of ['Intro paragraph', 'Second body run', 'Tail text']) {
      parts.push(Buffer.from(w, 'ascii'));
      parts.push(Buffer.from([0x0d, 0x0a]));
    }
    await fs.writeFile(path.join(dir, 'legacy.doc'), Buffer.concat(parts));
    const parsed = await parseDocument(path.join(dir, 'legacy.doc'));
    assert.ok(parsed, 'doc should parse');
    assert.match(parsed.text, /Intro paragraph/);
    assert.match(parsed.text, /Second body run/);
    assert.match(parsed.text, /Tail text/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseDocument returns null for a corrupt/empty binary file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-empty-'));
  try {
    await fs.writeFile(path.join(dir, 'bad.doc'), Buffer.from([0x00, 0x01, 0x02]));
    const parsed = await parseDocument(path.join(dir, 'bad.doc'));
    assert.equal(parsed, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseDocument extracts structured sections from a .sgml file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-sgml-'));
  try {
    const sgml = [
      '<!doctype sgml>',
      '<title>SGML Spec &amp; Notes</title>',
      'Preamble text here before sections.',
      '<sect1><title>Overview</title>',
      'This is the <emphasis>overview</emphasis> of the document.',
      '<!-- a comment to strip -->',
      '</sect1>',
      '<sect2><title>Details</title>',
      'Details body with &lt;tags&gt; and &amp; ampersands.',
      '</sect2>',
    ].join('\n');
    await fs.writeFile(path.join(dir, 'doc.sgml'), sgml);
    const parsed = await parseDocument(path.join(dir, 'doc.sgml'));
    assert.ok(parsed, 'sgml should parse');
    assert.equal(parsed.kind, 'doc');
    // Title decoded from the first <title> element.
    assert.equal(parsed.title, 'SGML Spec & Notes');
    // Entities decoded, tags/comments stripped in flat text.
    assert.match(parsed.text, /SGML Spec & Notes/);
    assert.match(parsed.text, /Preamble text here/);
    assert.match(parsed.text, /overview/);
    assert.ok(!parsed.text.includes('<!--'), 'comments must be stripped');
    assert.ok(!parsed.text.includes('<emphasis>'), 'tags must be stripped');
    // Sections: preamble (level 0) + Overview (level 1) + Details (level 2).
    const titles = parsed.sections.map(s => s.title);
    assert.ok(titles.some(t => /SGML Spec/.test(t)));
    assert.ok(titles.includes('Overview'));
    assert.ok(titles.includes('Details'));
    const overview = parsed.sections.find(s => s.title === 'Overview');
    assert.match(overview.body, /overview of the document/);
    const details = parsed.sections.find(s => s.title === 'Details');
    assert.match(details.body, /<tags>/); // &lt;tags&gt; decoded
    assert.match(details.body, /& ampersands/); // &amp; decoded
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseDocument routes .txt to plain-text parsing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-txt-'));
  try {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'First line.\n\nSecond paragraph here.\n');
    const parsed = await parseDocument(path.join(dir, 'notes.txt'));
    assert.ok(parsed, 'txt should parse');
    assert.equal(parsed.kind, 'doc');
    assert.match(parsed.text, /First line\./);
    assert.match(parsed.text, /Second paragraph here\./);
    assert.ok(parsed.sections.length >= 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('parseDocument handles a .sgml file with no structural elements', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-sgml-flat-'));
  try {
    // Flat SGML-ish text with no sect1/chapter/etc. -> single fallback section.
    await fs.writeFile(path.join(dir, 'flat.sgml'),
      '<para>Just some <literal>text</literal> content.</para>');
    const parsed = await parseDocument(path.join(dir, 'flat.sgml'));
    assert.ok(parsed, 'flat sgml should parse');
    assert.match(parsed.text, /Just some text content/);
    assert.ok(parsed.sections.length >= 1, 'should have at least one section');
    assert.match(parsed.sections[0].body, /Just some text content/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/* ----------------------------- isLearnableExt --------------------------- */

test('isLearnableExt accepts required + text-ish formats, rejects code/binary', () => {
  for (const ext of ['md', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'txt', 'rst', 'json', 'yaml', 'html', 'sgml']) {
    assert.equal(isLearnableExt(ext), true, `expected ${ext} learnable`);
  }
  for (const ext of ['js', 'ts', 'py', 'exe', 'png', 'zip', '']) {
    assert.equal(isLearnableExt(ext), false, `expected ${ext || '(none)'} NOT learnable`);
  }
});

/* ------------------------------ walkLearnFiles -------------------------- */

test('walkLearnFiles recurses, filters to learnable exts, reports unsupported', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-walk-'));
  try {
    // nested supported files
    await fs.mkdir(path.join(root, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'a.md'), '# A');
    await fs.writeFile(path.join(root, 'sub', 'b.pdf'), '%PDF-1.4');
    await fs.writeFile(path.join(root, 'sub', 'deep', 'c.docx'), 'x');
    await fs.writeFile(path.join(root, 'sub', 'deep', 'd.pptx'), 'y');
    await fs.writeFile(path.join(root, 'sub', 'e.sgml'), '<para>sgml</para>');
    // unsupported / hidden
    await fs.writeFile(path.join(root, 'note.txt'), 'txt is supported'); // txt IS supported
    await fs.writeFile(path.join(root, 'image.png'), 'png');
    await fs.writeFile(path.join(root, '.hidden.md'), 'hidden'); // skipped (hidden)
    await fs.writeFile(path.join(root, 'code.js'), 'js');

    const unsupported = [];
    const files = await walkLearnFiles(root, unsupported);
    const names = files.map(f => path.basename(f)).sort();
    assert.deepEqual(names, ['a.md', 'b.pdf', 'c.docx', 'd.pptx', 'e.sgml', 'note.txt']);
    const unsupNames = unsupported.map(f => path.basename(f)).sort();
    assert.deepEqual(unsupNames, ['code.js', 'image.png']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkLearnFiles returns empty for a missing directory', async () => {
  const unsupported = [];
  const files = await walkLearnFiles('/no/such/dir/here', unsupported);
  assert.deepEqual(files, []);
  assert.deepEqual(unsupported, []);
});

/* ----------------------------- reconcilePlan ---------------------------- */

test('reconcilePlan adds a fallback batch for files the LLM dropped', () => {
  const parsedFiles = [
    { path: 'a.md' }, { path: 'b.pdf' }, { path: 'c.docx' },
  ];
  // LLM only covered a.md and b.pdf - c.docx is dropped.
  const plan = [
    { topic: 'overview', description: 'intro', files: ['a.md', 'b.pdf'] },
  ];
  const out = reconcilePlan(plan, parsedFiles);
  const allFiles = out.flatMap(b => b.files);
  assert.ok(allFiles.includes('c.docx'), 'dropped file c.docx must get a fallback batch');
  // every parsed file is covered
  for (const f of parsedFiles) assert.ok(allFiles.includes(f.path));
});

test('reconcilePlan drops batches that reference hallucinated paths', () => {
  const parsedFiles = [{ path: 'real.md' }];
  const plan = [
    { topic: 'good', description: '', files: ['real.md'] },
    { topic: 'bad', description: '', files: ['nonexistent.pdf'] },
  ];
  const out = reconcilePlan(plan, parsedFiles);
  const topics = out.map(b => b.topic);
  assert.ok(topics.includes('good'));
  assert.ok(!topics.includes('bad'), 'hallucinated batch must be removed');
});

test('reconcilePlan handles a non-array / empty plan by covering all files', () => {
  const parsedFiles = [{ path: 'x.md' }, { path: 'y.pdf' }];
  const out = reconcilePlan(null, parsedFiles);
  const allFiles = out.flatMap(b => b.files);
  assert.ok(allFiles.includes('x.md'));
  assert.ok(allFiles.includes('y.pdf'));
});

/* ------------------------------- parseFlags ----------------------------- */

test('parseFlags parses --space, --file, --base-dir, --dry-run + positional text', () => {
  // --dry-run must come last (or be alone): a bare flag followed by a
  // non-flag token is treated as `--flag <value>` by parseFlags.
  const f = parseFlags(['--space=eden', '--file', '/tmp/a.md', 'focus', 'on', 'APIs', '--dry-run']);
  assert.equal(f.space, 'eden');
  assert.equal(f.file, '/tmp/a.md');
  assert.equal(f['dry-run'], true);
  assert.equal(f.positionalText, 'focus on APIs');
});

test('parseFlags treats --space without a value as boolean true', () => {
  const f = parseFlags(['--space']);
  assert.equal(f.space, true);
});

/* ------------------- end-to-end dry run with mock LLM ------------------- */
//
// We exercise knowledgeLearnKb through cmdKb. The project store + KB root are
// isolated under a temp HK2_HOME (set at the top of this file), so
// getProjectOrFail() returns a real registered project and listKnowledge()
// reads an empty KB. dry-run avoids writeKnowledge, so no KB data is created.
//
// ctx.streamLLM is stubbed to return a plan (Phase 1) then JSON entries
// (Phase 2); ctx.print output is captured for assertions.

let __registeredProject = null;

async function ensureProject(sourceDir) {
  // Register a fresh project per source dir so each test is isolated. The
  // project's sourcePath is informational here; the learn handler resolves
  // --file/--base-dir against the CWD, not sourcePath.
  __registeredProject = await home.registerProject({ sourcePath: sourceDir, name: 'learn-test-' + Date.now() });
  // getProjectOrFail prefers ctx.getCurrentProject but falls back to the
  // shared global "current" pointer — set it so KB writes (seeding + learn)
  // land in THIS project, not whatever test ran before.
  await setCurrentProject(__registeredProject.id);
  return __registeredProject;
}

function makeMockCtx({ planOutput, extractOutput }) {
  const prints = [];
  let call = 0;
  return {
    prints,
    llm: { /* truthy presence check */ },
    streamLLM: async function* () {
      call++;
      if (call === 1) {
        yield { type: 'delta', text: planOutput };
      } else {
        yield { type: 'delta', text: extractOutput };
      }
    },
    print: (s) => { prints.push(String(s)); },
    setPhase: () => {},
    confirm: async () => true,
    rt: null,
  };
}

test('knowledgeLearnKb dry-run parses a markdown file and proposes an entry', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-e2e-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# API Doc\n\nThe `doThing` function does the thing.\n');
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({
      planOutput: 'overview | intro batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'learned-api',
        title: 'Learned API Note',
        intro: 'A note extracted from the document about the API surface.',
        keyFiles: ['a.md'],
        keySymbols: ['doThing'],
        keywords: ['api', 'learned'],
      }]),
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md'), '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /Deep-studying 1 file/);
    assert.match(out, /parsed: 1\/1 files/);
    assert.match(out, /\[ACCEPT\] learned-api/);
    assert.match(out, /\[dry-run\] 1 entries would have been validated & written/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb defaults --space to eden (no longer an error)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-nospace-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# hi');
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({ planOutput: '', extractOutput: '[]' });
    await cmdKb(['knowledge', 'learn', '--file=' + path.join(tmpDir, 'a.md'), '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    // --space is optional now: doc mode targets eden by default.
    assert.match(out, /mode=documents\s+space=eden/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb without --file/--base-dir runs whole-project code mode', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-noarg-'));
  try {
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({ planOutput: '', extractOutput: '[]' });
    await cmdKb(['knowledge', 'learn', '--space=eden'], ctx);
    const out = ctx.prints.join('\n');
    // Bare `learn` is the merged whole-project CODE mode (old `knowledge init`).
    assert.match(out, /mode=code/);
    // The test project has no indexed files, so it stops with a clear hint.
    assert.match(out, /No indexed files\. Run \/kb init first\./);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb rejects both --file and --base-dir', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-both-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# hi');
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({ planOutput: '', extractOutput: '[]' });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md'), '--base-dir=' + tmpDir], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /only one of --file or --base-dir/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb walks a directory and learns every supported file', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-dir-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'docs', 'nested'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'docs', 'one.md'), '# One\n\nfirst doc');
    await fs.writeFile(path.join(tmpDir, 'docs', 'nested', 'two.md'), '# Two\n\nsecond doc');
    await fs.writeFile(path.join(tmpDir, 'docs', 'skip.png'), 'png');
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({ planOutput: '', extractOutput: '[]' });
    // Mock LLM covers both files in its plan; returns one entry per extraction.
    let call = 0;
    ctx.streamLLM = async function* () {
      call++;
      if (call === 1) {
        yield { type: 'delta', text: 'batch | all | one.md, two.md\n' };
      } else {
        yield { type: 'delta', text: JSON.stringify([
          { id: 'entry-' + call, title: 'T', intro: 'I', keyFiles: [], keySymbols: [], keywords: [] },
        ]) };
      }
    };
    await cmdKb(['knowledge', 'learn', '--space=eden', '--base-dir=' + path.join(tmpDir, 'docs'), '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /Deep-studying 2 files/);
    assert.match(out, /parsed: 2\/2 files/);
    assert.match(out, /skipped 1 unsupported file/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb safety net studies a file the planner dropped', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-drop-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# A\n\nfirst');
    await fs.writeFile(path.join(tmpDir, 'b.md'), '# B\n\nsecond');
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({ planOutput: '', extractOutput: '[]' });
    // Planner only mentions a.md -> b.md is dropped and must be picked up by
    // reconcilePlan, which adds a single-file fallback batch for it.
    let call = 0;
    ctx.streamLLM = async function* () {
      call++;
      if (call === 1) {
        yield { type: 'delta', text: 'only-a | first | a.md\n' };
      } else {
        yield { type: 'delta', text: JSON.stringify([
          { id: 'entry-' + call, title: 'T', intro: 'I', keyFiles: [], keySymbols: [], keywords: [] },
        ]) };
      }
    };
    await cmdKb(['knowledge', 'learn', '--space=eden', '--base-dir=' + tmpDir, '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    // b.md must be covered by a fallback batch (reconcilePlan safety net).
    assert.match(out, /single-file fallback for b\.md/);
    // Every parsed file was studied: two batches in total.
    assert.match(out, /Study plan: 2 batches/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/* ----------------------- large-file chunking (no content loss) ---------- */

test('chunkDocText keeps small documents as a single chunk', () => {
  const out = chunkDocText('hello world\nsecond line\n', 100000);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'hello world\nsecond line'); // trimmed like parsed doc text
  assert.equal(out[0].start, 0);
});

test('chunkDocText splits large documents into parts with no content loss', () => {
  // 10 lines of ~101 chars -> ~1010 chars; chunk size 300 with 20-char overlap.
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(`line-${i}: ` + 'x'.repeat(90));
  const text = lines.join('\n');
  const out = chunkDocText(text, 300, 20);
  assert.ok(out.length >= 4, `expected multiple chunks, got ${out.length}`);
  for (const c of out) {
    assert.ok(c.text.length <= 300, `chunk exceeds maxChars: ${c.text.length}`);
  }
  // Every character of the original must be covered by some chunk (no gaps).
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].start <= out[i - 1].end, `gap between chunk ${i - 1} and ${i}`);
  }
  // First chunk starts at the beginning; the last chunk reaches the end.
  assert.ok(out[0].text.startsWith('line-0:'), 'first chunk should start at the beginning');
  assert.ok(out[out.length - 1].text.includes('line-9:'), 'last chunk should reach the end');
  // Consecutive chunks overlap so boundary content is visible to both.
  assert.ok(out[1].start < out[0].end, 'chunks should overlap slightly');
  // Chunks prefer line boundaries: the first cut lands on a newline because
  // one is available inside the overlap window (mid-line cuts are only a
  // fallback when the window has no newline before the hard budget cap).
  assert.equal(out[0].text[out[0].text.length - 1], '\n', 'first cut should prefer a line boundary');
});

test('chunkDocText returns [] for empty / whitespace-only input', () => {
  assert.deepEqual(chunkDocText('   \n  '), []);
  assert.deepEqual(chunkDocText(null), []);
  assert.deepEqual(chunkDocText(''), []);
});

test('groupByBudget splits oversized batches into budget-sized groups', () => {
  const mk = (path, n) => ({ path, text: 'y'.repeat(n) });
  const sources = [mk('a.md', 60000), mk('b.pdf.part1', 60000), mk('c.md', 20000)];
  const groups = groupByBudget(sources, 100000);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(s => s.path), ['a.md']);
  assert.deepEqual(groups[1].map(s => s.path), ['b.pdf.part1', 'c.md']);
  for (const g of groups) {
    const total = g.reduce((s, f) => s + f.text.length, 0);
    assert.ok(total <= 100000, `group over budget: ${total}`);
  }
  // Every source appears exactly once across groups.
  assert.deepEqual(groups.flat().map(s => s.path), ['a.md', 'b.pdf.part1', 'c.md']);
  // Under-budget input stays in a single group.
  assert.equal(groupByBudget([mk('a.md', 100)], 100000).length, 1);
});

test('labelMatches resolves chunk labels, base labels and space-containing names', () => {
  assert.ok(labelMatches('book.pdf.part2', 'book.pdf.part2'));
  assert.ok(labelMatches('book.pdf.part2', 'book.pdf'), 'chunk label should match its base label');
  assert.ok(labelMatches('book.pdf', 'book.pdf.part2'), 'base label should match a chunk label');
  assert.ok(labelMatches('The Internals of PostgreSQL.pdf.part1', 'PostgreSQL.pdf'), 'tail-only echo of a space-containing chunk label');
  assert.ok(labelMatches('The Internals of PostgreSQL.pdf.part1', 'The Internals of PostgreSQL.pdf'));
  assert.ok(labelMatches('docs/a.md', 'a.md'), 'relative path should match basename');
  assert.ok(!labelMatches('a.md', 'b.md'));
  assert.ok(!labelMatches('book.pdf.part2', 'other.pdf'));
});

test('knowledgeLearnKb splits a large file into parts and studies every part', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-chunk-'));
  try {
    // ~105k chars -> with --per-batch-chars=40000 it splits into 3 parts.
    const big = ['# Big Book', ''];
    for (let i = 0; i < 400; i++) big.push(`section-${i}: ` + 'z'.repeat(250));
    await fs.writeFile(path.join(tmpDir, 'big.md'), big.join('\n'));
    await ensureProject(tmpDir);
    const ctx = makeMockCtx({
      planOutput: 'chunks | all parts | big.md.part1, big.md.part2, big.md.part3\n',
      extractOutput: JSON.stringify([
        { id: 'chunk-entry', title: 'Chunk Entry', intro: 'I', keyFiles: [], keySymbols: [], keywords: [] },
      ]),
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'big.md'), '--per-batch-chars=40000', '--dry-run'], ctx);
    const out = ctx.prints.join('\n');
    // The file was split, not truncated: all three parts appear in the plan.
    assert.match(out, /split into 3 study parts/);
    assert.match(out, /big\.md\.part1/);
    // The single planned batch is studied in budget-sized sub-batches.
    assert.match(out, /sub-batch 2\/3: big\.md\.part2/);
    assert.match(out, /sub-batch 3\/3: big\.md\.part3/);
    // Every part produced a proposal (no silent content loss).
    assert.match(out, /total proposed: 3/);
    assert.match(out, /total accepted: 3/);
    assert.match(out, /\[dry-run\] 3 entries would have been validated & written/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/* ------- semantic validation wiring: duplicate / update / conflict / new -------
 *
 * The /kb knowledge learn flow now runs the same validation pipeline as the
 * turn-end [kb learn] (lib/agent/kb_validate.js): every proposed entry is
 * pre-filtered (findCandidateEntries) then judged (validateLearnedEntry).
 * The mock LLM below plays BOTH roles: plan/extract via ctx.streamLLM, the
 * validator verdict via ctx.llm.stream (distinguished by its system prompt).
 * --------------------------------------------------------------------------- */

function makeValidateMockCtx({ planOutput, extractOutput, verdicts = [], confirmAnswers = [] }) {
  const prints = [];
  let call = 0;
  const vq = [...verdicts];
  const cq = [...confirmAnswers];
  return {
    prints,
    llm: {
      stream: async function* (messages) {
        const isValidator = messages?.[0]?.content?.includes('validating a newly-learned knowledge entry');
        const raw = isValidator
          ? (vq.length
            ? vq.shift()
            : JSON.stringify({ verdict: 'new', targetId: null, reason: 'default', conflictWinner: null, mergedIntro: null }))
          : '';
        yield { type: 'delta', text: raw };
      },
    },
    streamLLM: async function* () {
      call++;
      if (call === 1) yield { type: 'delta', text: planOutput };
      else yield { type: 'delta', text: extractOutput };
    },
    print: (s) => { prints.push(String(s)); },
    setPhase: () => {},
    confirm: async () => (cq.length ? cq.shift() : false),
    rt: null,
  };
}

async function seedEntry(projectId, space, entry) {
  await writeKnowledge(projectId, space, entry);
  return readKnowledge(projectId, space, entry.id);
}

test('knowledgeLearnKb validation: duplicate → skip write, keep original, print reason', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-dup-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    const seed = await seedEntry(p.id, 'eden', {
      id: 'dup-target', space: 'eden', title: 'Existing API Note',
      intro: 'Existing note about the API surface.', keywords: ['api', 'note'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'dup-prop', title: 'Another API Note', intro: 'Essentially the same API note.',
        keywords: ['api', 'note'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'duplicate', targetId: 'dup-target', reason: 'same meaning as the existing note', conflictWinner: null, mergedIntro: null })],
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[SKIP\] dup-prop: duplicate of "dup-target"/);
    assert.match(out, /same meaning as the existing note/);
    const eden = await listKnowledge(p.id, 'eden');
    assert.equal(eden.length, 1);
    assert.equal(eden[0].id, 'dup-target');
    assert.equal(eden[0].intro, 'Existing note about the API surface.');
    assert.equal(eden[0].createdAt, seed.createdAt);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: update → merge in place, createdAt preserved', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-upd-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    const seed = await seedEntry(p.id, 'eden', {
      id: 'up-target', space: 'eden', title: 'CLI Command Catalog',
      intro: 'Old: lists a few commands.', keywords: ['cli', 'commands'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'cli-extra', title: 'CLI Command Catalog v2', intro: 'Freshly extracted command knowledge.',
        keywords: ['cli', 'commands'], keyFiles: ['a.md'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'update', targetId: 'up-target', reason: 'same topic, fresher content', conflictWinner: null, mergedIntro: 'Merged: lists all commands, old and new.' })],
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[UPDATE\] cli-extra → eden:"up-target" \(merge in place\)/);
    const merged = await readKnowledge(p.id, 'eden', 'up-target');
    assert.ok(merged, 'merged entry exists');
    assert.equal(merged.intro, 'Merged: lists all commands, old and new.');
    assert.equal(merged.updatedByLearn, true);
    assert.equal(merged.createdAt, seed.createdAt, 'createdAt must survive the in-place merge');
    const eden = await listKnowledge(p.id, 'eden');
    assert.equal(eden.filter(e => e.id === 'cli-extra').length, 0, 'no sibling entry created');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: holy conflict, user DECLINES → original kept', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-hc-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    const seed = await seedEntry(p.id, 'holy', {
      id: 'h-conflict', space: 'holy', title: 'Deploy Policy',
      intro: 'Deploy via k8s only.', keywords: ['deploy', 'policy'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'h-prop', title: 'Deploy Policy bare metal', intro: 'Deploy on bare metal instead.',
        keywords: ['deploy', 'policy'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'conflict', targetId: 'h-conflict', reason: 'fresh ground truth from docs', conflictWinner: 'new', mergedIntro: null })],
      // [0] = run-level holy write gate, [1] = the per-entry conflict confirm (declined).
      confirmAnswers: [true, false],
    });
    await cmdKb(['knowledge', 'learn', '--space=holy', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[CONFLICT\] h-prop vs holy:"h-conflict"/);
    assert.match(out, /\[SKIP\] h-prop: keeping the existing Holy entry/);
    const holy = await readKnowledge(p.id, 'holy', 'h-conflict');
    assert.equal(holy.intro, 'Deploy via k8s only.');
    assert.equal(holy.createdAt, seed.createdAt);
    const list = await listKnowledge(p.id, 'holy');
    assert.equal(list.filter(e => e.id === 'h-prop').length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: holy conflict, user APPROVES → holy updated in place', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-hy-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    const seed = await seedEntry(p.id, 'holy', {
      id: 'h-conflict2', space: 'holy', title: 'Deploy Policy Two',
      intro: 'Old policy.', keywords: ['deploy', 'policy'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'h-prop2', title: 'Deploy Policy Two revised', intro: 'New winning policy.',
        keywords: ['deploy', 'policy'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'conflict', targetId: 'h-conflict2', reason: 'docs supersede the old policy', conflictWinner: 'new', mergedIntro: null })],
      // [0] = run-level holy write gate, [1] = the per-entry conflict confirm (approved).
      confirmAnswers: [true, true],
    });
    await cmdKb(['knowledge', 'learn', '--space=holy', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const holy = await readKnowledge(p.id, 'holy', 'h-conflict2');
    assert.equal(holy.intro, 'New winning policy.');
    assert.equal(holy.updatedByLearn, true);
    assert.equal(holy.createdAt, seed.createdAt, 'createdAt preserved on holy conflict update');
    const list = await listKnowledge(p.id, 'holy');
    assert.equal(list.filter(e => e.id === 'h-prop2').length, 0, 'no sibling created');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: eden conflict existing-wins → skip; new-wins → both kept', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-ec-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    // --- existing wins ---
    {
      const p = await ensureProject(tmpDir);
      await seedEntry(p.id, 'eden', {
        id: 'e-conflict', space: 'eden', title: 'Cache Strategy',
        intro: 'Use LRU everywhere.', keywords: ['cache', 'strategy'],
      });
      const ctx = makeValidateMockCtx({
        planOutput: 'topic | batch | a.md\n',
        extractOutput: JSON.stringify([{
          id: 'e-prop', title: 'Cache Strategy alt', intro: 'Use FIFO everywhere.',
          keywords: ['cache', 'strategy'],
        }]),
        verdicts: [JSON.stringify({ verdict: 'conflict', targetId: 'e-conflict', reason: 'extraction looks stale', conflictWinner: 'existing', mergedIntro: null })],
      });
      await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
      const out = ctx.prints.join('\n');
      assert.match(out, /\[SKIP\] e-prop: the existing entry wins/);
      const eden = await listKnowledge(p.id, 'eden');
      assert.equal(eden.length, 1);
      assert.equal(eden[0].intro, 'Use LRU everywhere.');
    }
    // --- new wins ---
    {
      const p2 = await ensureProject(tmpDir);
      await seedEntry(p2.id, 'eden', {
        id: 'e-conflict', space: 'eden', title: 'Cache Strategy',
        intro: 'Use LRU everywhere.', keywords: ['cache', 'strategy'],
      });
      const ctx = makeValidateMockCtx({
        planOutput: 'topic | batch | a.md\n',
        extractOutput: JSON.stringify([{
          id: 'e-prop2', title: 'Cache Strategy alt2', intro: 'Use FIFO everywhere (fresh).',
          keywords: ['cache', 'strategy'],
        }]),
        verdicts: [JSON.stringify({ verdict: 'conflict', targetId: 'e-conflict', reason: 'fresh ground truth', conflictWinner: 'new', mergedIntro: null })],
      });
      await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
      const out = ctx.prints.join('\n');
      assert.match(out, /The contradicting eden entry "e-conflict" is kept/);
      const eden = await listKnowledge(p2.id, 'eden');
      assert.equal(eden.length, 2, 'both the new entry and the stale one exist for manual review');
      assert.ok(eden.some(e => e.id === 'e-prop2'));
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: verdict new with related entries → reason printed for NOT updating', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-new-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    await seedEntry(p.id, 'eden', {
      id: 'rel-entry', space: 'eden', title: 'API Overview',
      intro: 'General API overview.', keywords: ['api'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'fresh-entry', title: 'API Auth Flow', intro: 'Covers the auth aspect only.',
        keywords: ['api', 'auth'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'new', targetId: null, reason: 'covers a different aspect: auth flow', conflictWinner: null, mergedIntro: null })],
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[ACCEPT\] fresh-entry.*new, NOT updating eden:rel-entry/);
    assert.match(out, /reason: covers a different aspect: auth flow/);
    const eden = await listKnowledge(p.id, 'eden');
    assert.equal(eden.filter(e => e.id === 'fresh-entry').length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: retired (supersededBy) eden entries are never merge targets', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-ret-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    // Retired entry: superseded by a holy entry — must be invisible to the
    // validator (same exclusion buildRequestGraph applies).
    await writeKnowledge(p.id, 'eden', {
      id: 'retired-entry', space: 'eden', title: 'Retired Cache Strategy',
      intro: '[Superseded by holy] stale content.', keywords: ['cache', 'strategy'],
      supersededBy: 'holy:something', supersededAt: new Date().toISOString(),
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'cache-fresh', title: 'Cache Strategy fresh', intro: 'Brand-new cache knowledge.',
        keywords: ['cache', 'strategy'],
      }]),
      verdicts: [], // no validator call should even happen (no candidates)
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.doesNotMatch(out, /\[UPDATE\]/);
    assert.doesNotMatch(out, /retired-entry/);
    const retired = await readKnowledge(p.id, 'eden', 'retired-entry');
    assert.equal(retired.supersededBy, 'holy:something', 'retirement stamp must survive untouched');
    const fresh = await readKnowledge(p.id, 'eden', 'cache-fresh');
    assert.ok(fresh, 'the fresh entry is written as new');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: near-identical proposals in the SAME batch see each other', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-mirror-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([
        { id: 'first-entry', title: 'Auth Flow', intro: 'Auth flow knowledge.', keywords: ['auth', 'flow'] },
        { id: 'second-entry', title: 'Auth Flow again', intro: 'The same auth flow knowledge.', keywords: ['auth', 'flow'] },
      ]),
      verdicts: [
        // first-entry has NO candidates (empty KB) → no validator call; the
        // single queued verdict is consumed by second-entry, which sees the
        // pending mirror of first-entry.
        JSON.stringify({ verdict: 'duplicate', targetId: 'first-entry', reason: 'duplicate of the sibling proposed in this same batch', conflictWinner: null, mergedIntro: null }),
      ],
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /\[SKIP\] second-entry: duplicate of "first-entry"/);
    const eden = await listKnowledge(p.id, 'eden');
    assert.equal(eden.filter(e => e.id === 'first-entry').length, 1);
    assert.equal(eden.filter(e => e.id === 'second-entry').length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb gate: HK2_KB_LEARN_VALIDATE=0 restores legacy deterministic discard', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-gate-'));
  const prev = process.env.HK2_KB_LEARN_VALIDATE;
  process.env.HK2_KB_LEARN_VALIDATE = '0';
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    await seedEntry(p.id, 'eden', {
      id: 'legacy-hit', space: 'eden', title: 'Legacy Entry',
      intro: 'Existing.', keywords: ['legacy', 'entry'],
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{
        id: 'legacy-prop', title: 'Legacy Entry Again', intro: 'Would collide by keywords.',
        keywords: ['legacy', 'entry'],
      }]),
      verdicts: [], // must not be consulted at all
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /skipped: 1/);
    assert.match(out, /\[SKIP\] legacy-prop: conflicts with "legacy-hit"/);
    const eden = await listKnowledge(p.id, 'eden');
    assert.equal(eden.length, 1);
  } finally {
    if (prev === undefined) delete process.env.HK2_KB_LEARN_VALIDATE;
    else process.env.HK2_KB_LEARN_VALIDATE = prev;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: validator targeting hk2-supreme-code is refused (codes must survive)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-sc-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Governance\n\nThe project supreme code rules everything.');
    const p = await ensureProject(tmpDir);
    const { writeSupremeCode, ensureSupremeCode } = await import('../lib/store/supreme_code.js');
    await ensureSupremeCode(p.id);
    await writeSupremeCode(p.id, ['API密钥严禁出现在代码中'], { createdVia: 'test' });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      // Title "Project Supreme Code" hits the supreme-code entry by mutual
      // title containment — the validator then (adversarially) targets it.
      extractOutput: JSON.stringify([{
        id: 'governance-notes', title: 'Project Supreme Code', intro: 'Learned governance notes.', keywords: ['governance'],
      }]),
      verdicts: [JSON.stringify({ verdict: 'update', targetId: 'hk2-supreme-code', reason: 'same topic per title containment', conflictWinner: null, mergedIntro: 'Merged governance notes.' })],
      confirmAnswers: [true], // user approves the per-entry holy-merge prompt — must STILL be refused
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const out = ctx.prints.join('\n');
    assert.match(out, /permanent Supreme Code entry/);
    assert.match(out, /skipped: 1/);
    const { readKnowledge } = await import('../lib/store/kb_store.js');
    const raw = await readKnowledge(p.id, 'holy', 'hk2-supreme-code');
    assert.ok(raw, 'supreme-code entry must still exist');
    assert.deepEqual(raw.codes, ['API密钥严禁出现在代码中'], 'codes array must survive untouched');
    assert.equal(raw.protected, true, 'protected flag must survive');
    assert.equal(raw.updatedByLearn, undefined, 'no learn update may be applied onto the supreme code');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('knowledgeLearnKb validation: update merge preserves spaceChangedAt on a same-space entry', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'learn-val-sca-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'a.md'), '# Doc\n\ncontent');
    const p = await ensureProject(tmpDir);
    await writeKnowledge(p.id, 'eden', {
      id: 'sca-target', space: 'eden', title: 'CLI Catalog',
      intro: 'Old.', keywords: ['cli'],
      createdAt: '2020-01-01T00:00:00.000Z', spaceChangedAt: '2021-06-01T00:00:00.000Z',
    });
    const ctx = makeValidateMockCtx({
      planOutput: 'topic | batch | a.md\n',
      extractOutput: JSON.stringify([{ id: 'sca-prop', title: 'CLI Catalog v2', intro: 'Fresh.', keywords: ['cli'] }]),
      verdicts: [JSON.stringify({ verdict: 'update', targetId: 'sca-target', reason: 'same topic', conflictWinner: null, mergedIntro: 'Merged.' })],
    });
    await cmdKb(['knowledge', 'learn', '--space=eden', '--file=' + path.join(tmpDir, 'a.md')], ctx);
    const after = await readKnowledge(p.id, 'eden', 'sca-target');
    assert.equal(after.createdAt, '2020-01-01T00:00:00.000Z', 'createdAt preserved');
    assert.equal(after.spaceChangedAt, '2021-06-01T00:00:00.000Z', 'in-space merge must not reset spaceChangedAt');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
