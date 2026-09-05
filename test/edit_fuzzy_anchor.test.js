/*-------------------------------------------------------------------------
 *
 * Regression tests for the edit tool's layered anchor matching — the
 * "oldText not found" high-frequency failure family.
 *
 * Layers, in order:
 *   L0  verbatim byte-exact indexOf
 *   L0b EOL fallback (LF-form oldText on a CRLF file)  [v1.1.107]
 *   L1  fuzzy fallback (v2): whitespace-insensitive line-signature
 *       sequence match, unique-only, with file-anchored reassembly
 *       (sequential alignment + ratio/shift indent transform)
 *   L2  diagnostic errors (near-line locator, batch position) and the
 *       replaceAll escape hatch for non-unique anchors
 *
 * Safety invariants pinned here:
 *   - verbatim match is NEVER fuzzy-ified (model intent survives);
 *   - ambiguous signatures fail loudly and write NOTHING;
 *   - paraphrased oldText (different words) still fails — the fuzzy layer
 *     absorbs whitespace drift only, never content drift;
 *   - the file's indentation style (tab vs space) and line endings survive
 *     every applied edit.
 *
 * Run:  node --test test/edit_fuzzy_anchor.test.js
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
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-edit-fuzzy-${n}-`));
}

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
  return { edit: tools.find(t => t.name === 'edit') };
}

test('L1 absorbs indent-width drift and preserves the file\'s 2-space style', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'indent.js');
  await fs.writeFile(f, 'function foo() {\n  if (x) {\n    return 1;\n  }\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // The model reconstructed oldText from read()'s numbered display and
    // doubled every indent (2-space copied as 4-space).
    const r = await edit.execute({
      path: f,
      old_string: 'function foo() {\n    if (x) {\n        return 1;\n    }\n}',
      new_string: 'function foo() {\n    if (x) {\n        return 2;\n    }\n}',
    });
    assert.equal(r.error, undefined, `must apply via fuzzy fallback, got ${JSON.stringify(r)}`);
    assert.ok(Array.isArray(r.fuzzyAdapted) && r.fuzzyAdapted.length === 1, 'fuzzyAdapted surfaces the adaptation');
    const after = await fs.readFile(f, 'utf8');
    // The file keeps its own 2-space style — the model's 4-space indent must
    // NOT leak through, and the changed line lands at the file's indent.
    assert.equal(after, 'function foo() {\n  if (x) {\n    return 2;\n  }\n}\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L1 absorbs tab↔space drift and preserves the file\'s tab style', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'tabs.js');
  await fs.writeFile(f, 'function bar() {\n\tif (y) {\n\t\treturn 3;\n\t}\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({
      path: f,
      old_string: 'function bar() {\n  if (y) {\n    return 3;\n  }\n}',
      new_string: 'function bar() {\n  if (z) {\n    return 4;\n  }\n}',
    });
    assert.equal(r.error, undefined);
    const after = await fs.readFile(f, 'utf8');
    assert.equal(after, 'function bar() {\n\tif (z) {\n\t\treturn 4;\n\t}\n}\n', 'tab file stays tabs — no space indent leaks');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L1 absorbs trailing-whitespace drift', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'trailing.js');
  await fs.writeFile(f, 'const a = 1; \nconst b = 2;\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, old_string: 'const a = 1;\nconst b = 2;', new_string: 'const A = 1;\nconst B = 2;' });
    assert.equal(r.error, undefined);
    assert.equal(await fs.readFile(f, 'utf8'), 'const A = 1;\nconst B = 2;\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L1 absorbs blank-line collapse in the reconstructed oldText', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'blanks.js');
  await fs.writeFile(f, 'function a() {\n\n  return 1;\n\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // The model dropped the blank lines when copying from the display.
    const r = await edit.execute({ path: f, old_string: 'function a() {\n  return 1;\n}', new_string: 'function a() {\n  return 2;\n}' });
    assert.equal(r.error, undefined);
    // The file's blank lines are PRESERVED (the anchor's span keeps interior
    // blanks on the file side); only the content of the signature line changed.
    assert.equal(await fs.readFile(f, 'utf8'), 'function a() {\n\n  return 2;\n\n}\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L1 on a CRLF file: indent drift absorbed, file stays pure CRLF', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'crlf_indent.js');
  await fs.writeFile(f, 'function foo() {\r\n  if (x) {\r\n    return 1;\r\n  }\r\n}\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({
      path: f,
      old_string: 'function foo() {\n    if (x) {\n        return 1;\n    }\n}',
      new_string: 'function foo() {\n    if (x) {\n        return 2;\n    }\n}',
    });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(await fs.readFile(f, 'utf8'), 'function foo() {\r\n  if (x) {\r\n    return 2;\r\n  }\r\n}\r\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('verbatim match keeps priority — a byte-exact oldText is never fuzzy-ified', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'verbatim.js');
  await fs.writeFile(f, '    indented();\n    indented2();\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // oldText matches byte-exactly; the model deliberately wants the
    // replacement at a NARROWER indent. Fuzzy must not touch this.
    const r = await edit.execute({ path: f, old_string: '    indented();\n', new_string: '  replaced();\n' });
    assert.equal(r.error, undefined);
    assert.equal(r.fuzzyAdapted, undefined, 'verbatim path: no fuzzy adaptation reported');
    assert.equal(await fs.readFile(f, 'utf8'), '  replaced();\n    indented2();\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('ambiguous signature fails loudly and writes nothing', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'amb.js');
  await fs.writeFile(f, 'a();\ndo();\nb();\nc();\ndo();\nd();\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, old_string: 'do();\n', new_string: 'DONE();\n' });
    assert.ok(r.error && r.error.includes('not unique'), `must fail as non-unique, got ${JSON.stringify(r)}`);
    assert.equal(await fs.readFile(f, 'utf8'), 'a();\ndo();\nb();\nc();\ndo();\nd();\n', 'nothing written');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L2 diagnostics: failure carries the near-line locator and batch position', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'diag.js');
  await fs.writeFile(f, 'function computeTotal(items) {\n  return items.length;\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // Paraphrased first line — but a near line IS findable via the shared
    // prefix "function compute".
    const r = await edit.execute({
      path: f,
      old_string: 'function computeAll(items) {\n  return items.size;\n}',
      new_string: 'x',
    });
    assert.ok(r.error && r.error.includes('oldText not found'), 'still a hard failure for content drift');
    assert.ok(r.error.includes('near line 1'), `near-line locator present: ${r.error}`);
    // Multi-edit batch: the SECOND edit fails; the first matched but nothing
    // was written (all-or-nothing).
    const f2 = path.join(tree, 'multi.js');
    await fs.writeFile(f2, 'alpha\nbeta\ngamma\n');
    const r2 = await edit.execute({
      path: f2,
      edits: [
        { oldText: 'beta', newText: 'BETA' },
        { oldText: 'no-such-line', newText: 'X' },
      ],
    });
    assert.ok(r2.error && r2.error.includes('edit 2 of 2 failed'), `batch position present: ${r2.error}`);
    assert.ok(r2.error.includes('1 earlier edit(s) matched'), `appliedBefore present: ${r2.error}`);
    assert.equal(await fs.readFile(f2, 'utf8'), 'alpha\nbeta\ngamma\n', 'all-or-nothing: nothing written');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('L2 replaceAll: explicit escape hatch replaces every occurrence', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'ra.js');
  await fs.writeFile(f, 'log("x");\nlog("x");\nlog("x");\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, old_string: 'log("x");', new_string: 'LOG("x");', replaceAll: true });
    assert.equal(r.error, undefined);
    assert.equal(await fs.readFile(f, 'utf8'), 'LOG("x");\nLOG("x");\nLOG("x");\n');
    // replaceAll works through the EOL fallback too (CRLF file)
    const f2 = path.join(tree, 'ra_crlf.js');
    await fs.writeFile(f2, 'log("y");\r\nlog("y");\r\n');
    const r2 = await edit.execute({ path: f2, old_string: 'log("y");', new_string: 'LOG("y");', replaceAll: true });
    assert.equal(r2.error, undefined, JSON.stringify(r2));
    assert.equal(await fs.readFile(f2, 'utf8'), 'LOG("y");\r\nLOG("y");\r\n', 'CRLF preserved');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('single-line oldText with indent drift learns the shift', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'single.js');
  await fs.writeFile(f, '  foo();\n  bar();\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // oldText says 4-space, file says 2-space — one pair votes shift -2.
    const r = await edit.execute({ path: f, old_string: '    foo();', new_string: '    FOO();' });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(await fs.readFile(f, 'utf8'), '  FOO();\n  bar();\n', 'file indent (2sp) preserved');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('new lines added below the anchor inherit the learned ratio indent', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'ratio.js');
  await fs.writeFile(f, 'class A {\n  method() {\n    stmt();\n  }\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // oldText reconstructed at double indent (2→4, 4→8): ratio ×2 learned
    // from interior lines; the NEW line d() is emitted at the file's scale.
    const r = await edit.execute({
      path: f,
      old_string: 'class A {\n    method() {\n        stmt();\n    }\n}',
      new_string: 'class A {\n    method() {\n        stmt();\n        d();\n    }\n}',
    });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(await fs.readFile(f, 'utf8'), 'class A {\n  method() {\n    stmt();\n    d();\n  }\n}\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit on a CRLF file with a single-line oldText and multi-line newText keeps CRLF', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'crlf_single_multi.js');
  await fs.writeFile(f, 'alpha\r\nbeta\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // Verbatim single-line anchor on a CRLF file: the multi-line replacement
    // must convert to CRLF, not inject bare LF breaks.
    const r = await edit.execute({ path: f, old_string: 'alpha', new_string: 'one\ntwo' });
    assert.equal(r.error, undefined);
    assert.equal(await fs.readFile(f, 'utf8'), 'one\r\ntwo\r\nbeta\r\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('fuzzy anchor preceded by a blank line still counts ONE match (no double-count)', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'blank_before.js');
  await fs.writeFile(f, 'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // The target region is preceded by a blank line (ubiquitous between
    // functions). The matcher used to count the same occurrence twice —
    // once starting on the blank line, once on the anchor's first line —
    // and reject a UNIQUE anchor as ambiguous.
    const r = await edit.execute({
      path: f,
      old_string: 'function two() {\n    return 2;\n}',
      new_string: 'function two() {\n    return 22;\n}',
    });
    assert.equal(r.error, undefined, `unique anchor must apply, got ${JSON.stringify(r)}`);
    assert.equal(await fs.readFile(f, 'utf8'), 'function one() {\n  return 1;\n}\n\nfunction two() {\n  return 22;\n}\n', 'separating blank line preserved');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('preserved blank lines in a CRLF file never produce \\r\\r\\n', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'crlf_blank_preserve.js');
  await fs.writeFile(f, 'function a() {\r\n\r\n  return 1;\r\n\r\n}\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // Collapsed oldText (no blanks) + CRLF file: preserved interior blanks
    // used to keep their trailing '\r' and the join+convert step then added
    // another CRLF after them — silently corrupting the file with '\r\r\n'.
    const r = await edit.execute({ path: f, old_string: 'function a() {\n  return 1;\n}', new_string: 'function a() {\n  return 11;\n}' });
    const after = await fs.readFile(f, 'utf8');
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.ok(!after.includes('\r\r'), `no stray CR: ${JSON.stringify(after)}`);
    assert.equal(after, 'function a() {\r\n\r\n  return 11;\r\n\r\n}\r\n', 'blanks preserved, pure CRLF');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('empty oldText is rejected up front — never splices between characters', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'empty_anchor.js');
  await fs.writeFile(f, 'abc def\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // indexOf('') is ALWAYS 0 (never -1): without the guard the anchor
    // "matches" everywhere — with replaceAll it splices the replacement
    // between every character (and infinite-loops the occurrence counter).
    const r = await edit.execute({ path: f, old_string: '', new_string: 'X', replaceAll: true });
    assert.ok(r.error && r.error.includes('non-empty'), `clean rejection, got ${JSON.stringify(r)}`);
    assert.equal(await fs.readFile(f, 'utf8'), 'abc def\n', 'file untouched');
    const r2 = await edit.execute({ path: f, old_string: '', new_string: 'X' });
    assert.ok(r2.error && r2.error.includes('non-empty'), 'rejected without replaceAll too');
    assert.equal(await fs.readFile(f, 'utf8'), 'abc def\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});
