#!/usr/bin/env node
/**
 * check-docs.mjs — documentation consistency checker (Node stdlib only).
 *
 * Run: npm run docs:check   (or: node scripts/check-docs.mjs)
 *
 * Checks:
 *   1. Bilingual structure — the docs/en and docs/zh-CN trees must contain
 *      exactly the same set of relative .md paths; every missing file is
 *      reported with the language it lacks; each page pair, and the two root
 *      READMEs, must also have matching heading-level, table-shape, and
 *      fence-language sequences.
 *   2. Language-switch links — every English page must contain a Markdown
 *      link that resolves to its Chinese counterpart, and vice versa (the
 *      link target is resolved, not just the label text).
 *   3. Local Markdown links & images — every relative link in README.md,
 *      README_zh.md, and every file under docs/ must point at an existing
 *      file (query/fragment stripped; pure #anchors skipped;
 *      http/https/mailto ignored).
 *   4. Quality gates — no `<repo-url>` placeholders or TODO/TBD markers
 *      anywhere (raw text, including inside code examples); every code
 *      fence (backtick or tilde, length >= 3) carries a language tag and
 *      no fence is left unclosed; README.md ↔ README_zh.md cross-link;
 *      README.md → docs/en/README.md; README_zh.md → docs/zh-CN/README.md;
 *      docs/README.md links both language indexes.
 *
 * The structural parity checks compare document shape, not translated meaning:
 * they cannot prove that the two languages make the same factual claims.
 *
 * All problems are collected and reported; the process exits non-zero if
 * any check failed.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 * Fence scanner (CommonMark-ish): fences are 3+ backticks or 3+ tildoes,
 * optionally indented up to 3 spaces. A closing fence must use the same
 * character, be at least as long, and carry no info string. Returns the
 * text with fenced-block CONTENT blanked (link checks must not fire on
 * examples) plus per-fence issues: missing language tag / unclosed fence.
 */
export function scanFences(raw) {
  const lines = raw.split('\n');
  const out = [];
  const issues = [];
  const fences = [];
  let fence = null; // { char, len, line }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (m) {
      const chars = m[1];
      const info = m[2].trim();
      if (!fence) {
        fence = { char: chars[0], len: chars.length, line: i + 1 };
        fences.push({ language: info ? info.split(/\s+/)[0] : '' });
        if (!info) issues.push({ line: i + 1, kind: 'no-language' });
      } else if (chars[0] === fence.char && chars.length >= fence.len && !info) {
        fence = null; // proper close
      }
      out.push(''); // fences themselves are never link-relevant
      continue;
    }
    out.push(fence ? '' : line); // blank content while inside a fence
  }
  if (fence) issues.push({ line: fence.line, kind: 'unclosed' });
  return { stripped: out.join('\n'), issues, fences };
}

function stripInlineCode(text) {
  return text.replace(/`+[^`\n]*`+/g, ' ');
}

function splitTableCells(line) {
  let text = stripInlineCode(line).trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const ch of text) {
    if (ch === '|' && !escaped) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
    escaped = ch === '\\' && !escaped;
    if (ch !== '\\') escaped = false;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableSeparator(line) {
  if (!line || !line.includes('|')) return false;
  const cells = splitTableCells(line);
  return cells.length >= 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

/** Scan rendered ATX headings, allowing Markdown's 0–3 indentation spaces. */
export function scanHeadings(stripped) {
  const headings = [];
  const re = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/gm;
  for (const match of stripped.matchAll(re)) {
    headings.push({
      level: match[1].length,
      text: match[2].trim(),
      index: match.index,
    });
  }
  return headings;
}

/** Extract shape-only signals used for bilingual structural parity. */
export function extractStructuralSignature(raw) {
  const scanned = scanFences(raw);
  const lines = scanned.stripped.split('\n');
  const headingLevels = scanHeadings(scanned.stripped).map(h => h.level);

  const tables = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !isTableSeparator(lines[i + 1])) continue;
    const columns = splitTableCells(lines[i]).length;
    let rows = 0;
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || !line.includes('|')) break;
      const cells = splitTableCells(line);
      if (cells.length !== columns) break;
      rows++;
    }
    tables.push({ columns, rows });
    i++;
  }

  return {
    headingLevels,
    tables,
    fenceLanguages: scanned.fences.map(f => f.language),
  };
}

/**
 * Strip fenced code blocks and inline code spans for the LINK checks —
 * links inside code are examples, not live references. (Placeholder and
 * marker checks intentionally run on RAW text; see the quality gates.)
 */
function stripCode(text) {
  return scanFences(text).stripped.replace(/`[^`\n]*`/g, ' ');
}

/**
 * Extract local Markdown link/image targets from text.
 * Matches [label](target) and ![alt](target); skips http(s)/mailto/auto-link
 * targets and pure #anchors. Returns targets with query/fragment stripped.
 */
export function extractLocalLinks(text) {
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


function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function zhCounterpart(enAbs) { return enAbs.replace(`${path.sep}en${path.sep}`, `${path.sep}zh-CN${path.sep}`); }
function enCounterpart(zhAbs) { return zhAbs.replace(`${path.sep}zh-CN${path.sep}`, `${path.sep}en${path.sep}`); }

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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

/** Compare shape-only signals for a bilingual pair without comparing prose. */
function checkStructuralParity(enAbs, zhAbs, label) {
  const enRaw = rawContents.get(enAbs);
  const zhRaw = rawContents.get(zhAbs);
  if (enRaw === undefined || zhRaw === undefined) return;
  const enShape = extractStructuralSignature(enRaw);
  const zhShape = extractStructuralSignature(zhRaw);
  if (JSON.stringify(enShape.headingLevels) !== JSON.stringify(zhShape.headingLevels)) {
    problem(enAbs, `${label} heading-level sequence differs\nen: ${JSON.stringify(enShape.headingLevels)}\nzh: ${JSON.stringify(zhShape.headingLevels)}`);
  }
  if (JSON.stringify(enShape.tables) !== JSON.stringify(zhShape.tables)) {
    problem(enAbs, `${label} table structural signature differs\nen: ${JSON.stringify(enShape.tables)}\nzh: ${JSON.stringify(zhShape.tables)}`);
  }
  if (JSON.stringify(enShape.fenceLanguages) !== JSON.stringify(zhShape.fenceLanguages)) {
    problem(enAbs, `${label} fenced-code language sequence differs\nen: ${JSON.stringify(enShape.fenceLanguages)}\nzh: ${JSON.stringify(zhShape.fenceLanguages)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2b. Pair structural parity                                          */
/* ------------------------------------------------------------------ */
for (const rel of enFiles) {
  if (!zhSet.has(rel)) continue;
  const enAbs = path.join(EN, rel);
  const zhAbs = path.join(ZH, rel);
  checkStructuralParity(enAbs, zhAbs, 'docs page pair:');
}

// The root READMEs are the other bilingual pair. Their links and quality
// gates are checked below; compare only document shape here, not translation.
checkStructuralParity(ROOT_READMES[0], ROOT_READMES[1], 'root README pair:');

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
  if (/\b(TODO|TBD)\b/.test(raw)) {
    problem(abs, 'contains a TODO/TBD marker');
  }
  // Fence hygiene: every opening fence needs a language tag, and no fence may
  // be left unclosed (backticks or tildes, any length >= 3).
  for (const issue of scanFences(raw).issues) {
    if (issue.kind === 'no-language') {
      problem(abs, `code fence at line ${issue.line} has no language tag`);
    } else {
      problem(abs, `unclosed code fence starting at line ${issue.line}`);
    }
  }

  // Structure gates (docs pages + root READMEs): exactly one ATX H1, the
  // language-switch link directly under it (docs pages), and no heading
  // level skips. Headings inside fenced code are ignored via scanFences.
  {
    const body = scanFences(raw).stripped;
    const headings = scanHeadings(body);
    const h1s = headings.filter((h) => h.level === 1);
    if (h1s.length !== 1) {
      problem(abs, `has ${h1s.length} ATX H1 headings (expected exactly 1)`);
    }
    let prev = 0;
    for (const h of headings) {
      if (prev && h.level > prev + 1) {
        problem(abs, `heading level skips from H${prev} to H${h.level} at "${h.text.slice(0, 40)}"`);
      }
      prev = h.level;
    }
    // Language switch must appear in the first non-empty block after the H1.
    if (abs.startsWith(DOCS) && abs !== path.join(DOCS, 'README.md')) {
      const partner = abs.startsWith(EN)
        ? zhCounterpart(abs)
        : abs.startsWith(ZH) ? enCounterpart(abs) : null;
      // Use the H1 match already found above. Do not search for a new literal
      // "# " anchor: prose, non-standard spacing, or fenced headings must not
      // move the first-block boundary. A page with multiple H1s already gets
      // its structural error; skip this secondary location diagnostic.
      if (partner && h1s.length === 1) {
        const h1 = h1s[0];
        const h1Newline = body.indexOf('\n', h1.index);
        const afterH1 = h1Newline < 0 ? '' : body.slice(h1Newline + 1);
        const firstBlock = afterH1.trim().split(/\n\s*\n/)[0] || '';
        const linkedTargets = extractLocalLinks(firstBlock)
          .map(target => safeResolve(abs, target))
          .filter(Boolean);
        if (!linkedTargets.includes(partner)) {
          problem(abs, 'language-switch link not in the first block under the H1');
        }
      }
    }
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

}
