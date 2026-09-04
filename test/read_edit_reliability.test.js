/*-------------------------------------------------------------------------
 *
 * Regression tests for the read/edit/write tool reliability fixes — the
 * read/edit siblings of the "grep 模式没命中" failure class.
 *
 * Root causes covered (all previously reproduced live):
 *   1. read on a CRLF file: every line carried a trailing \r (invisible
 *      noise that corrupted the model's verbatim oldText copies for edit).
 *   2. read totalLines counted the trailing-newline PHANTOM element — a
 *      3-line file reported 4, and offset=last returned a phantom empty row.
 *   3. edit with an LF-form multi-line oldText on a CRLF file ALWAYS failed
 *      with "oldText not found" (byte-exact indexOf, no EOL variant probe)
 *      — and when a single-line edit DID succeed, the LF-form newText
 *      injected mixed line endings into the CRLF file.
 *   4. kb_search slices (loadSlices) had the same CRLF + phantom problems.
 *   5. read of a binary file returned mojibake silently (NUL-byte guard now
 *      rejects with a clear error).
 *   6. read's promised 256KB byte cap was never enforced (only the 2000-line
 *      cap existed); now truncation is line-granular and REPORTED.
 *
 * Run:  node --test test/read_edit_reliability.test.js
 *----------------------------------------------------------------------*/

import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTools } from '../lib/agent/tools.js';
import { shortHash } from '../lib/util/hash.js';
import { resetPermissionService } from '../lib/config/setting.js';

let __seq = 0;

async function makeTree() {
  const n = ++__seq;
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-readedit-rel-${n}-`));
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
  return {
    read: tools.find(t => t.name === 'read'),
    edit: tools.find(t => t.name === 'edit'),
    write: tools.find(t => t.name === 'write'),
  };
}

test('read on a CRLF file: no CR in output, true line count', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'crlf.js'), 'line1\r\nneedle here\r\nline3\r\n');
  await withWorkspace(tree, async () => {
    const { read } = getTools();
    const r = await read.execute({ path: path.join(tree, 'crlf.js') });
    assert.equal(r.error, undefined);
    assert.equal(r.totalLines, 3, 'CRLF 3-line file reports 3, not 4');
    assert.ok(!r.content.includes('\r'), 'no CR glued to any displayed line');
    assert.equal(r.shownLines, '1-3');
    // Lines are display-normalized only; the raw file is untouched.
    const raw = await fs.readFile(path.join(tree, 'crlf.js'), 'utf8');
    assert.ok(raw.includes('\r\n'), 'file on disk keeps its CRLF endings');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('read totalLines drops the trailing-newline phantom; offset past last line is honest', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'lf.js'), 'l1\nl2\nl3\n');
  await withWorkspace(tree, async () => {
    const { read } = getTools();
    let r = await read.execute({ path: path.join(tree, 'lf.js') });
    assert.equal(r.totalLines, 3, '3 lines + trailing NL is still 3 lines');
    assert.ok(!r.content.includes('\n     4'), 'no phantom 4th row');
    // offset = last line: shows exactly one real row.
    r = await read.execute({ path: path.join(tree, 'lf.js'), offset: 3 });
    assert.equal(r.shownLines, '3-3');
    assert.equal(r.content, '     3\tl3');
    // offset beyond the last line: empty content + an honest note.
    r = await read.execute({ path: path.join(tree, 'lf.js'), offset: 9 });
    assert.equal(r.totalLines, 3);
    assert.ok(r.note && r.note.includes('beyond the last line'), `note present: ${r.note}`);
    // empty file: zero lines, no phantom
    await fs.writeFile(path.join(tree, 'empty.js'), '');
    r = await read.execute({ path: path.join(tree, 'empty.js') });
    assert.equal(r.totalLines, 0);
    // no-trailing-newline file keeps its last line visible and countable
    await fs.writeFile(path.join(tree, 'noeol.js'), 'a\nb');
    r = await read.execute({ path: path.join(tree, 'noeol.js') });
    assert.equal(r.totalLines, 2);
    assert.ok(r.content.includes('b'), 'last line without trailing NL still shown');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: LF-form multi-line oldText on a CRLF file matches (EOL fallback) and keeps CRLF on write', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'crlf_edit.js');
  await fs.writeFile(f, 'alpha\r\nbeta gamma\r\nomega\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // The model read the file (display-normalized) and copied LF text.
    const r = await edit.execute({
      path: f,
      old_string: 'alpha\nbeta gamma',
      new_string: 'ALPHA\nBETA GAMMA',
    });
    assert.equal(r.error, undefined, `must apply via CRLF fallback, got ${JSON.stringify(r)}`);
    assert.equal(r.applied, 1);
    assert.ok(Array.isArray(r.eolAdapted) && r.eolAdapted.length === 1, 'eolAdapted surfaces the adaptation');
    const after = await fs.readFile(f, 'utf8');
    assert.equal(after, 'ALPHA\r\nBETA GAMMA\r\nomega\r\n', 'file stays pure CRLF — no mixed endings');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: single-line oldText (no \\n) on a CRLF file still matches verbatim and does not inject LF', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'crlf_single.js');
  await fs.writeFile(f, 'alpha\r\nbeta gamma\r\nomega\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, old_string: 'beta', new_string: 'BETA' });
    assert.equal(r.error, undefined);
    assert.equal(r.applied, 1);
    assert.equal(r.eolAdapted, undefined, 'no EOL adaptation needed for a \\n-free anchor');
    const after = await fs.readFile(f, 'utf8');
    assert.equal(after, 'alpha\r\nBETA gamma\r\nomega\r\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: verbatim LF oldText on an LF file is untouched by the fallback (no behavior change)', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'lf_edit.js');
  await fs.writeFile(f, 'start\nmiddle\nend\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, edits: [{ oldText: 'middle', newText: 'MIDDLE' }, { oldText: 'end\n', newText: 'END\n' }] });
    assert.equal(r.error, undefined);
    assert.equal(r.applied, 2, 'multi-edit array still works');
    assert.equal(r.eolAdapted, undefined);
    assert.equal(await fs.readFile(f, 'utf8'), 'start\nMIDDLE\nEND\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: a CRLF-form oldText on an LF file fails loudly (fallback is one-directional)', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'lf_strict.js');
  await fs.writeFile(f, 'alpha\nbeta\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, old_string: 'alpha\r\nbeta', new_string: 'x' });
    assert.ok(r.error && r.error.includes('oldText not found'), 'CRLF anchor on LF file must keep failing');
    assert.equal(await fs.readFile(f, 'utf8'), 'alpha\nbeta\n', 'file untouched');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: tag anchor still hashes RAW content (CRLF display normalization does not break stale detection)', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'tagged.js');
  await fs.writeFile(f, 'alpha\r\nbeta\r\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    // The tag read() would return is shortHash of the RAW (CRLF) content —
    // display normalization must not change what the anchor hashes.
    const rawTag = shortHash(await fs.readFile(f, 'utf8'));
    // edit with the correct tag succeeds even though display was normalized
    const ok = await edit.execute({ path: f, old_string: 'beta', new_string: 'BETA', tag: rawTag });
    assert.equal(ok.error, undefined, `tag must validate against raw content, got ${JSON.stringify(ok)}`);
    // edit with a stale tag is rejected
    const stale = await edit.execute({ path: f, old_string: 'BETA', new_string: 'x', tag: rawTag });
    assert.ok(stale.error && stale.error.includes('stale tag'), 'stale tag still rejected');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('read rejects binary files with a NUL-byte guard instead of returning mojibake', async () => {
  const tree = await makeTree();
  await fs.writeFile(path.join(tree, 'bin.js'), Buffer.concat([Buffer.from('weird\x00stuff'), Buffer.from([0xff, 0xfe])]));
  await withWorkspace(tree, async () => {
    const { read } = getTools();
    const r = await read.execute({ path: path.join(tree, 'bin.js') });
    assert.ok(r.error && r.error.includes('binary file'), `must reject binary, got ${JSON.stringify(r).slice(0, 80)}`);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('read enforces the 256KB byte cap with a reported truncation (line-granular)', async () => {
  const tree = await makeTree();
  // ~50 lines × 8KB ≈ 400KB of content — over the byte cap, under the line cap.
  const big = ('x'.repeat(8000) + '\n').repeat(50);
  await fs.writeFile(path.join(tree, 'big.txt'), big);
  await withWorkspace(tree, async () => {
    const { read } = getTools();
    const r = await read.execute({ path: path.join(tree, 'big.txt') });
    assert.equal(r.error, undefined);
    assert.equal(r.totalLines, 50);
    assert.ok(r.truncated === true, 'byte-cap truncation must be reported');
    assert.ok(r.note && r.note.includes('offset='), `note tells how to continue: ${r.note}`);
    // The follow-up read from the hinted offset works.
    const m = r.note.match(/offset=(\d+)/);
    assert.ok(m, 'note carries a numeric offset');
    const r2 = await read.execute({ path: path.join(tree, 'big.txt'), offset: Number(m[1]) });
    assert.equal(r2.error, undefined);
    assert.ok(r2.shownLines.startsWith(m[1]), 'follow-up read starts at the hinted line');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('read normal 2000-line cap and offset/limit slicing still work (no regression)', async () => {
  const tree = await makeTree();
  const lines = [];
  for (let i = 1; i <= 2500; i++) lines.push(`line-${i}`);
  await fs.writeFile(path.join(tree, 'many.txt'), lines.join('\n') + '\n');
  await withWorkspace(tree, async () => {
    const { read } = getTools();
    let r = await read.execute({ path: path.join(tree, 'many.txt') });
    assert.equal(r.totalLines, 2500);
    assert.equal(r.shownLines, '1-2000', 'default line cap still 2000');
    r = await read.execute({ path: path.join(tree, 'many.txt'), offset: 2001 });
    assert.equal(r.shownLines, '2001-2500', 'continuation read reaches the tail');
    assert.ok(r.content.includes('line-2500'));
    r = await read.execute({ path: path.join(tree, 'many.txt'), offset: 10, limit: 5 });
    assert.equal(r.shownLines, '10-14', 'offset+limit slicing exact');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('write tool round-trips content verbatim (no EOL or encoding surprises)', async () => {
  const tree = await makeTree();
  await withWorkspace(tree, async () => {
    const { write, read } = getTools();
    const payload = 'crlf line\r\nlf line\nno trailing';
    const w = await write.execute({ path: path.join(tree, 'rt.txt'), content: payload });
    assert.equal(w.error, undefined);
    assert.equal(w.bytes, Buffer.byteLength(payload));
    const raw = await fs.readFile(path.join(tree, 'rt.txt'), 'utf8');
    assert.equal(raw, payload, 'write preserves content byte-for-byte');
    // read reports the CRLF file with display-normalized lines
    const r = await read.execute({ path: path.join(tree, 'rt.txt') });
    assert.equal(r.totalLines, 3);
    assert.ok(!r.content.includes('\r'));
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: multi-edit entries observe evolving content in array order', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'evolving.js');
  await fs.writeFile(f, 'A\n');
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, edits: [
      { oldText: 'A', newText: 'B' },
      { oldText: 'B', newText: 'C' },
    ] });
    assert.equal(r.error, undefined);
    assert.equal(r.applied, 2);
    assert.equal(await fs.readFile(f, 'utf8'), 'C\n');
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: a later multi-edit failure leaves the original file untouched', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'atomic-on-error.js');
  const original = 'A\nB\n';
  await fs.writeFile(f, original);
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, edits: [
      { oldText: 'A', newText: 'changed' },
      { oldText: 'B', newText: 'missing-after-first-edit' },
      { oldText: 'not-present', newText: 'never' },
    ] });
    assert.match(r.error, /oldText not found/);
    assert.equal(await fs.readFile(f, 'utf8'), original);
  });
  await fs.rm(tree, { recursive: true, force: true });
});

test('edit: uniqueness is checked against the evolving content at every step', async () => {
  const tree = await makeTree();
  const f = path.join(tree, 'evolving-unique.js');
  const original = 'A\nB\n';
  await fs.writeFile(f, original);
  await withWorkspace(tree, async () => {
    const { edit } = getTools();
    const r = await edit.execute({ path: f, edits: [
      { oldText: 'A', newText: 'B' },
      { oldText: 'B', newText: 'C' },
    ] });
    assert.match(r.error, /oldText not unique/);
    assert.equal(await fs.readFile(f, 'utf8'), original);
  });
  await fs.rm(tree, { recursive: true, force: true });
});
