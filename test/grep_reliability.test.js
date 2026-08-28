/*-------------------------------------------------------------------------
 *
 * Regression tests for the grep/find/glob tool reliability fixes.
 *
 * Root causes covered (all previously reproduced as silent zero-match):
 *   1. path= pointing at a single FILE — old globWalk readdir'd it, got
 *      ENOTDIR, swallowed the error and scanned ZERO files ("read sees it,
 *      grep misses it").
 *   2. glob patterns with a './' prefix or a redundant root-relative dir
 *      prefix ('./src/' + '**' + '/*.js', 'src/' + '**' + '/*.js' with
 *      path=src) — the old per-segment name matcher never lined up, zero
 *      files matched.
 *   3. >500-file enumeration cap — files beyond the cap (by walk order)
 *      were silently never searched; no truncation signal existed.
 *   4. CRLF files — '\r' stayed glued to the line tail (match itself works,
 *      but line text carried the '\r'); normalized now.
 *
 * Run:  node --test test/grep_reliability.test.js
 *----------------------------------------------------------------------*/

import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTools } from '../lib/agent/tools.js';
import { resetPermissionService } from '../lib/config/setting.js';

let __seq = 0;

async function makeTree() {
  const n = ++__seq;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-grep-rel-${n}-`));
  return root;
}

// Point the permission service's workspace root at the temp tree so
// checkReal allows the walk (defaults to HK2_PROJECT_SOURCE / cwd).
async function withWorkspace(tree, fn) {
  const prev = process.env.HK2_PROJECT_SOURCE;
  process.env.HK2_PROJECT_SOURCE = tree;
  resetPermissionService();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HK2_PROJECT_SOURCE;
    else process.env.HK2_PROJECT_SOURCE = prev;
    resetPermissionService();
  }
}

function getTools() {
  const tools = buildTools(null, {});
  return {
    grep: tools.find(t => t.name === 'grep'),
    find: tools.find(t => t.name === 'find'),
  };
}

test('path pointing at a single FILE is searched (read-sees-grep-misses fix)', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'target.js'), 'line1\nneedle: progress.start here\nline3\n');
  await fs.writeFile(path.join(tree, 'other.js'), 'nothing\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'progress\\.start', path: path.join(tree, 'target.js') });
    assert.equal(r.error, undefined);
    assert.equal(r.count, 1, 'single-file path must be searched');
    assert.equal(r.matches[0].line, 2);
    assert.ok(!r.matches[0].text.includes('\r'), 'no CR glued to the matched line');
    // literal: true must also work on a file path
    const r2 = await grep.execute({ pattern: 'progress.start', literal: true, path: path.join(tree, 'target.js') });
    assert.equal(r2.count, 1, 'literal mode on single-file path');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('single-file path whose basename does NOT match the glob is skipped without error', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'target.txt'), 'needle here\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'needle', path: path.join(tree, 'target.txt'), glob: '*.js' });
    assert.equal(r.error, undefined);
    assert.equal(r.count, 0, 'glob-filtered out — zero matches, no crash');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('glob with ./ prefix matches (normalization fix)', async () => {
  const tree = await makeTree();
  await fs.mkdir(path.join(tree, 'src'), { recursive: true });
  await fs.writeFile(path.join(tree, 'src', 'a.js'), 'needle in src\n');
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();
    const r = await grep.execute({ pattern: 'needle', path: tree, glob: './src/**/*.js' });
    assert.equal(r.count, 1, './-prefixed glob must match');
    const g = await find.execute({ pattern: './src/**/*.js', path: tree });
    assert.equal(g.count, 1, 'find with ./-prefixed glob');
    assert.ok(g.files[0].endsWith('src/a.js'));
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('glob carrying a redundant root-relative dir prefix matches', async () => {
  const tree = await makeTree();
  await fs.mkdir(path.join(tree, 'src'), { recursive: true });
  await fs.writeFile(path.join(tree, 'src', 'a.js'), 'needle in src\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    // path=src + glob=src/**/*.js — user redundantly repeats the dir prefix
    const r = await grep.execute({ pattern: 'needle', path: path.join(tree, 'src'), glob: 'src/**/*.js' });
    assert.equal(r.count, 1, 'redundant dir prefix glob must match');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('needles beyond the enumeration cap are still found; truncation is reported', async () => {
  const tree = await makeTree();
  // ~620 files; needle files land at the END of alphabetical walk order
  for (const d of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x']) {
    const dir = path.join(tree, d);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 25; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), 'filler\n');
  }
  await fs.writeFile(path.join(tree, 'zzz_target.txt'), 'needle: progress.start here\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'progress\\.start', path: tree });
    // With the 2000-file cap the whole tree (~601 files) is scanned, so the
    // needle IS found and no truncation flag is set.
    assert.equal(r.count, 1, 'needle at the end of walk order must be found');
    assert.equal(r.filesTruncated, undefined, 'no truncation under the cap');
    assert.equal(r.scannedFiles, 601, 'scannedFiles reports the real file count');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('truncation flag fires when the cap is exceeded', async () => {
  const tree = await makeTree();
  for (const d of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z']) {
    const dir = path.join(tree, d);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < 90; i++) await fs.writeFile(path.join(dir, `f${i}.txt`), 'filler\n');
  }
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();
    // find with a small limit surfaces `truncated`
    const g = await find.execute({ pattern: '**/*', path: tree, limit: 100 });
    assert.equal(g.count, 100);
    assert.equal(g.truncated, true, 'find reports truncation');
    assert.ok(g.note.includes('capped'), 'truncation note present');
    // grep at 2340+ files: scan capped at 2000 → filesTruncated + note
    const r = await grep.execute({ pattern: 'progress\\.start', path: tree });
    assert.equal(r.filesTruncated, true, 'grep reports filesTruncated over the cap');
    assert.ok(r.note.includes('2000'), 'grep note mentions the cap');
    assert.equal(r.scannedFiles, 2000, 'scannedFiles equals the cap');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('CRLF files: lines split on CR too, matched text carries no CR', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'crlf.txt'), 'line one\r\nneedle progress.start\r\nend\r\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'progress\\.start', path: tree });
    assert.equal(r.count, 1);
    assert.equal(r.matches[0].line, 2);
    assert.equal(r.matches[0].text, 'needle progress.start');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('normal directory grep still works (no regression)', async () => {
  const tree = await makeTree();
  await fs.mkdir(path.join(tree, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tree, 'lib', 'a.js'), 'export function foo() {}\n');
  await fs.writeFile(path.join(tree, 'lib', 'b.ts'), 'export function bar() {}\n');
  await fs.writeFile(path.join(tree, 'lib', 'c.md'), 'docs mention foo\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'function (foo|bar)', path: tree, glob: '*.{js,ts}' });
    assert.equal(r.error, undefined);
    assert.equal(r.count, 2, 'brace-expansion-free alternation across js+ts');
    const all = await grep.execute({ pattern: 'foo', path: tree });
    assert.equal(all.count, 2, 'default catch-all glob finds js + md');
    const one = await grep.execute({ pattern: 'foo', path: tree, glob: '*.js' });
    assert.equal(one.count, 1, 'extension glob still single-segment');
    const ic = await grep.execute({ pattern: 'FOO', path: tree, ignoreCase: true });
    assert.equal(ic.count, 2, 'ignoreCase still works');
    const lit = await grep.execute({ pattern: 'foo() {', literal: true, path: tree });
    assert.equal(lit.count, 1, 'literal mode matches text with regex metachars verbatim');
    const litRe = await grep.execute({ pattern: 'foo() {', path: tree });
    assert.equal(litRe.count, 0, 'same text as REGEX reads () as an empty group — no match (proves escaping)');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('nested ** glob from a subdirectory root works', async () => {
  const tree = await makeTree();
  await fs.mkdir(path.join(tree, 'a', 'b', 'c'), { recursive: true });
  await fs.writeFile(path.join(tree, 'a', 'top.js'), 'needle top\n');
  await fs.writeFile(path.join(tree, 'a', 'b', 'mid.js'), 'needle mid\n');
  await fs.writeFile(path.join(tree, 'a', 'b', 'c', 'deep.js'), 'needle deep\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    const r = await grep.execute({ pattern: 'needle', path: path.join(tree, 'a'), glob: '**/*.js' });
    assert.equal(r.count, 3, '** from subroot reaches top + mid + deep');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('symlinked files are enumerated (not silently dropped by isFile())', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'real.js'), 'needle in real\n');
  await fs.writeFile(path.join(tree, 'plain.js'), 'needle in plain\n');
  // Symlink TO A FILE: readdir reports isSymbolicLink(), not isFile().
  await fs.symlink(path.join(tree, 'real.js'), path.join(tree, 'link.js'));
  // Symlink to a file inside a subdirectory (via ../ traversal of the tree).
  await fs.mkdir(path.join(tree, 'sub'), { recursive: true });
  await fs.symlink(path.join(tree, 'real.js'), path.join(tree, 'sub', 'link2.js'));
  // Broken symlink: must be skipped without crashing the walk.
  await fs.symlink(path.join(tree, 'does-not-exist.js'), path.join(tree, 'broken.js'));
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();
    const r = await grep.execute({ pattern: 'needle', path: tree });
    assert.equal(r.error, undefined);
    assert.equal(r.count, 4, 'real + plain + both symlinks found; broken link skipped');
    const files = r.matches.map(m => m.file).sort();
    assert.deepEqual(files, ['link.js', 'plain.js', 'real.js', 'sub/link2.js']);
    const g = await find.execute({ pattern: '**/*', path: tree });
    assert.equal(g.count, 4, 'find also lists symlinked files (not dirs)');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('symlinked DIRECTORIES are walked through, not listed as files', async () => {
  const tree = await makeTree();
  const realDir = path.join(tree, 'realdir');
  await fs.mkdir(realDir, { recursive: true });
  await fs.writeFile(path.join(realDir, 'inner.js'), 'needle inner\n');
  await fs.symlink(realDir, path.join(tree, 'linkdir'));
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();
    const r = await grep.execute({ pattern: 'needle', path: tree });
    // The inner file is reachable via the symlinked dir. On most platforms
    // the walk visits both realdir/ and linkdir/ (two spellings of one dir)
    // so the same file may match twice — the key assertions are: at least one
    // match, and no DIRECTORY path ever pushed as a file.
    assert.ok(r.count >= 1, 'file behind a symlinked dir is found');
    assert.ok(r.matches.every(m => !m.file.endsWith('linkdir') || m.file.includes('/')),
      'no bare directory path reported as a match');
    const g = await find.execute({ pattern: '**/*', path: tree });
    for (const f of g.files) {
      const st = await fs.stat(f);
      assert.equal(st.isDirectory(), false, `find must not list directories: ${f}`);
    }
    assert.ok(g.files.some(f => f.endsWith('inner.js')), 'inner file reachable through the link dir');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test("trailing-** globs ('**' and 'src/**') match files, from repo root and subroot", async () => {
  const tree = await makeTree();
  await fs.mkdir(path.join(tree, 'src', 'sub'), { recursive: true });
  await fs.writeFile(path.join(tree, 'src', 'a.js'), 'needle a\n');
  await fs.writeFile(path.join(tree, 'src', 'sub', 'b.js'), 'needle b\n');
  await fs.writeFile(path.join(tree, 'top.js'), 'needle top\n');
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();

    // bare '**' from the tree root: everything.
    let g = await find.execute({ pattern: '**', path: tree });
    assert.equal(g.count, 3, `bare '**' from root matches all 3 files (got ${g.count})`);
    let r = await grep.execute({ pattern: 'needle', path: tree, glob: '**' });
    assert.equal(r.count, 3, `grep glob='**' finds all (got ${r.count})`);

    // 'src/**' from the tree root: only under src/.
    g = await find.execute({ pattern: 'src/**', path: tree });
    assert.equal(g.count, 2, `src/** matches src/a.js + src/sub/b.js (got ${g.count})`);
    r = await grep.execute({ pattern: 'needle', path: tree, glob: 'src/**' });
    assert.equal(r.count, 2, `grep glob='src/**' (got ${r.count})`);
    assert.ok(r.matches.every(m => m.file.startsWith('src/')), 'no file outside src/ matched');

    // bare '**' from the SUBDIRECTORY root src/: both files under it.
    g = await find.execute({ pattern: '**', path: path.join(tree, 'src') });
    assert.equal(g.count, 2, `bare '**' from subroot src matches its 2 files (got ${g.count})`);
    r = await grep.execute({ pattern: 'needle', path: path.join(tree, 'src'), glob: '**' });
    assert.equal(r.count, 2, `grep glob='**' from subroot (got ${r.count})`);

    // 'src/**' from the subdirectory root src/ (redundant prefix form).
    r = await grep.execute({ pattern: 'needle', path: path.join(tree, 'src'), glob: 'src/**' });
    assert.equal(r.count, 2, `redundant 'src/**' with path=src still matches (got ${r.count})`);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('context line numbers are correct near the top of the file (clamped slice)', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'head.txt'), 'alpha\nbeta\nGAMMA\ndelta\n');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    // Match at line 2 (i=1) with ctx=3: `before` is clamped to ONE line —
    // the old `i - ctx + j + 1` numbering produced line 0 / -1 here.
    let r = await grep.execute({ pattern: 'beta', path: tree, context: 3 });
    assert.equal(r.count, 1);
    assert.deepEqual(r.matches[0].before, [{ line: 1, text: 'alpha' }], 'clamped before starts at line 1');
    // Match at line 3 (i=2) with ctx=3: two before-lines numbered 1,2.
    r = await grep.execute({ pattern: 'GAMMA', path: tree, context: 3 });
    assert.deepEqual(r.matches[0].before, [{ line: 1, text: 'alpha' }, { line: 2, text: 'beta' }]);
    // Match at line 1: no before lines at all.
    r = await grep.execute({ pattern: 'alpha', path: tree, context: 2 });
    assert.deepEqual(r.matches[0].before, []);
    // after lines still numbered from match+1.
    r = await grep.execute({ pattern: 'beta', path: tree, context: 5 });
    assert.deepEqual(r.matches[0].after, [{ line: 3, text: 'GAMMA' }, { line: 4, text: 'delta' }]);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test("glob with a leading '/' (absolute-style spelling) matches", async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'f.txt'), 'GAMMA here\n');
  await withWorkspace(tree, async () => {
    const { grep, find } = getTools();
    const r = await grep.execute({ pattern: 'GAMMA', path: tree, glob: '/f.txt' });
    assert.equal(r.count, 1, `glob '/f.txt' must match f.txt (got ${r.count})`);
    const g = await find.execute({ pattern: '/f.txt', path: tree });
    assert.equal(g.count, 1, `find glob '/f.txt' (got ${g.count})`);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('non-existent path reports an error instead of a silent zero-match', async () => {
  const tree = await makeTree();
  await withWorkspace(tree, async () => {
    const { grep, find, } = getTools();
    // Missing path previously scanned ZERO files silently → "0 matches" →
    // the agent wrongly concluded the pattern was absent.
    const r = await grep.execute({ pattern: 'anything', path: path.join(tree, 'no-such-dir') });
    assert.ok(r.error && r.error.includes('path not found'), `grep must error on missing path, got ${JSON.stringify(r.error)}`);
    const g = await find.execute({ pattern: '**/*', path: path.join(tree, 'no-such-dir') });
    assert.ok(g.error && g.error.includes('path not found'), `find must error on missing path, got ${JSON.stringify(g.error)}`);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('no phantom empty line from trailing newline / empty file', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'trail.txt'), 'l1\nl2\nl3\n');
  await fs.writeFile(path.join(tree, 'empty.txt'), '');
  await fs.writeFile(path.join(tree, 'noeol.txt'), 'x\nlast-no-eol');
  await withWorkspace(tree, async () => {
    const { grep } = getTools();
    // ^$ must not match the phantom line after a trailing newline...
    let r = await grep.execute({ pattern: '^$', path: tree });
    assert.equal(r.count, 0, `phantom empty line must not match ^$ (got ${JSON.stringify(r.matches)})`);
    // ...nor the single phantom element of a 0-byte file.
    r = await grep.execute({ pattern: '^$', path: path.join(tree, 'empty.txt') });
    assert.equal(r.count, 0, 'empty file has no lines');
    // context after the last real line carries no phantom entry.
    r = await grep.execute({ pattern: 'l3', path: tree, context: 2 });
    assert.deepEqual(r.matches[0].after, [], 'no phantom after-line');
    // a file NOT ending in a newline still has its last line matchable.
    r = await grep.execute({ pattern: 'last-no-eol$', path: tree, glob: 'noeol.txt' });
    assert.equal(r.count, 1, 'no-trailing-newline anchor still matches');
  });
  await fs.rm(tree, { recursive: true, force: true });
});
