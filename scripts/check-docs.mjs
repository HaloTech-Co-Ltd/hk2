#!/usr/bin/env node
/**
 * check-docs.mjs — documentation consistency checker (Node stdlib only).
 *
 * Run: npm run docs:check   (or: node scripts/check-docs.mjs)
 *
 * Checks:
 *   1. Bilingual structure — the docs/en and docs/zh-CN trees must contain
 *      exactly the same set of relative .md paths; every missing file is
 *      reported with the language it lacks.
 *   2. Language-switch links — every English page must contain a Markdown
 *      link that resolves to its Chinese counterpart, and vice versa (the
 *      link target is resolved, not just the label text).
 *   3. Local Markdown links & images — every relative link in README.md,
 *      README_zh.md, and every file under docs/ must point at an existing
 *      file (query/fragment stripped; pure #anchors skipped;
 *      http/https/mailto ignored).
 *   4. Quality gates — no `<repo-url>` placeholders or TODO/TBD markers
 *      anywhere (raw text, including inside code examples); README.md ↔
 *      README_zh.md cross-link; README.md → docs/en/README.md;
 *      README_zh.md → docs/zh-CN/README.md; docs/README.md links both
 *      language indexes.
 *
 * All problems are collected and reported; the process exits non-zero if
 * any check failed.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const EN = path.join(DOCS, 'en');
const ZH = path.join(DOCS, 'zh-CN');
const ROOT_READMES = [path.join(ROOT, 'README.md'), path.join(ROOT, 'README_zh.md')];

const problems = [];
const notes = [];
const problem = (p, msg) => problems.push(`${path.relative(ROOT, p) || p}: ${msg}`);

/** Recursively collect .md files under dir, as relative paths from dir. */
async function collectMarkdown(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // missing dir — parity check reports it below
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await collectMarkdown(path.join(dir, e.name), rel)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
  return out.sort();
}

/**
 * Strip fenced code blocks and inline code spans. Links, placeholders, and
 * marker words inside code are examples, not live references — no check
 * should fire on them.
 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * Extract local Markdown link/image targets from text.
 * Matches [label](target) and ![alt](target); skips http(s)/mailto/auto-link
 * targets and pure #anchors. Returns targets with query/fragment stripped.
 */
function extractLocalLinks(text) {
  const targets = [];
  const re = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let t = m[2].trim();
    if (/^(https?:|mailto:|irc:|xmpp:)/i.test(t)) continue;
    if (t.startsWith('#')) continue;
    const hashOrQuery = t.search(/[?#]/);
    if (hashOrQuery >= 0) t = t.slice(0, hashOrQuery);
    if (t) targets.push(t);
  }
  return targets;
}

/** Resolve a link target against the containing file; true if it exists on disk. */
async function targetExists(fromFile, target) {
  const abs = path.resolve(path.dirname(fromFile), decodeURIComponent(target));
  try {
    await readFile(abs); // files only — a bare directory would fail UTF-8 read on most cases
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 1. Bilingual structure parity                                       */
/* ------------------------------------------------------------------ */
const enFiles = await collectMarkdown(EN);
const zhFiles = await collectMarkdown(ZH);

if (enFiles.length === 0) notes.push('docs/en contains no Markdown files');
if (zhFiles.length === 0) notes.push('docs/zh-CN contains no Markdown files');

const enSet = new Set(enFiles);
const zhSet = new Set(zhFiles);
for (const f of enFiles) {
  if (!zhSet.has(f)) problem(path.join(ZH, f), `missing Chinese counterpart for docs/en/${f}`);
}
for (const f of zhFiles) {
  if (!enSet.has(f)) problem(path.join(EN, f), `missing English counterpart for docs/zh-CN/${f}`);
}

/* ------------------------------------------------------------------ */
/* Load every checked file                                             */
/* ------------------------------------------------------------------ */
const docFiles = [...enFiles.map(f => path.join(EN, f)), ...zhFiles.map(f => path.join(ZH, f))];
const contents = new Map();     // code-stripped text — link & switch-link checks
const rawContents = new Map();  // raw text — placeholder / marker checks
for (const abs of [...docFiles, ...ROOT_READMES, path.join(DOCS, 'README.md')]) {
  try {
    const raw = await readFile(abs, 'utf8');
    // Links are checked on code-stripped text (examples inside code blocks /
    // inline code are illustrations, not live links). Placeholders and TODO
    // markers are checked on RAW text — a `<repo-url>` inside a fenced
    // `git clone` example is exactly the kind of leak to catch.
    rawContents.set(abs, raw);
    contents.set(abs, stripCode(raw));
  } catch {
    problem(abs, 'cannot read file');
  }
}

/* ------------------------------------------------------------------ */
/* 2. Language-switch links                                            */
/* ------------------------------------------------------------------ */
/**
 * Every en/zh page pair must link to each other: the en page contains some
 * link whose resolved target IS the zh file, and vice versa. Resolving the
 * target (rather than matching label text) catches wrong relative depths.
 */
for (const rel of enFiles) {
  const enAbs = path.join(EN, rel);
  const zhAbs = path.join(ZH, rel);
  const enText = contents.get(enAbs);
  const zhText = contents.get(zhAbs);
  if (!enText || !zhText) continue;

  const enLinks = extractLocalLinks(enText).map(t => safeResolve(enAbs, t)).filter(Boolean);
  const zhLinks = extractLocalLinks(zhText).map(t => safeResolve(zhAbs, t)).filter(Boolean);
  if (!enLinks.includes(zhAbs)) problem(enAbs, `no language-switch link to zh-CN counterpart (${rel})`);
  if (!zhLinks.includes(enAbs)) problem(zhAbs, `no language-switch link to en counterpart (${rel})`);
}

/* ------------------------------------------------------------------ */
/* 3. Local link targets                                               */
/* ------------------------------------------------------------------ */
/** Resolve a link target defensively: a malformed %xx sequence must not
 *  crash the whole run — report it as unresolvable instead. */
function safeResolve(fromFile, target) {
  try {
    return path.resolve(path.dirname(fromFile), decodeURIComponent(target));
  } catch {
    return null;
  }
}

for (const [abs, text] of contents) {
  for (const target of extractLocalLinks(text)) {
    const resolved = safeResolve(abs, target);
    if (resolved === null) {
      problem(abs, `malformed link target (bad percent-encoding): ${target}`);
      continue;
    }
    if (!(await targetExists(abs, target))) {
      problem(abs, `broken local link: ${target}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Quality gates                                                    */
/* ------------------------------------------------------------------ */
// Placeholders and markers are checked on RAW text (see the load comment):
// a <repo-url> or an unfinished-work marker inside a fenced bash example is
// exactly the kind of leak that must fail the check.
for (const [abs, raw] of rawContents) {
  if (raw.includes('<repo-url>')) problem(abs, 'contains a <repo-url> placeholder');
  if (abs.startsWith(DOCS) && /\b(TODO|TBD)\b/.test(raw)) {
    problem(abs, 'contains a TODO/TBD marker');
  }
}

const readmeEn = contents.get(path.join(ROOT, 'README.md')) || '';
const readmeZh = contents.get(path.join(ROOT, 'README_zh.md')) || '';
const docsIndex = contents.get(path.join(DOCS, 'README.md')) || '';

const linkTargetsOf = (text, fromFile) =>
  extractLocalLinks(text).map(t => safeResolve(fromFile, t)).filter(Boolean);

const enIndexAbs = path.join(EN, 'README.md');
const zhIndexAbs = path.join(ZH, 'README.md');
const rootReadmeEn = path.join(ROOT, 'README.md');
const rootReadmeZh = path.join(ROOT, 'README_zh.md');

if (!linkTargetsOf(readmeEn, rootReadmeEn).includes(enIndexAbs)) {
  problem(rootReadmeEn, 'does not link to docs/en/README.md');
}
if (!linkTargetsOf(readmeZh, rootReadmeZh).includes(zhIndexAbs)) {
  problem(rootReadmeZh, 'does not link to docs/zh-CN/README.md');
}
if (!linkTargetsOf(readmeEn, rootReadmeEn).includes(rootReadmeZh)) {
  problem(rootReadmeEn, 'does not link to README_zh.md');
}
if (!linkTargetsOf(readmeZh, rootReadmeZh).includes(rootReadmeEn)) {
  problem(rootReadmeZh, 'does not link to README.md');
}
{
  const t = linkTargetsOf(docsIndex, path.join(DOCS, 'README.md'));
  if (!t.includes(enIndexAbs) || !t.includes(zhIndexAbs)) {
    problem(path.join(DOCS, 'README.md'), 'must link both docs/en/README.md and docs/zh-CN/README.md');
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
for (const n of notes) console.error(`note: ${n}`);
if (problems.length === 0) {
  const pairs = enFiles.filter(f => zhSet.has(f)).length;
  console.log(`docs:check OK — ${pairs} bilingual page pairs, all local links resolve, quality gates clean.`);
  process.exit(0);
}
console.error(`docs:check FAILED — ${problems.length} problem(s):`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
