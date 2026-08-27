/*-------------------------------------------------------------------------
 *
 * Unit tests for the input history ring (src/tui/history.js) — in-memory
 * dedupe/cap and the JSONL round-trip (best-effort file semantics).
 *
 * Run:  node --test test/tui_history.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { History, historyPath } from '../src/tui/history.js';

test('in-memory: add, consecutive dedupe, blank rejected', () => {
  const h = new History(null);
  assert.equal(h.add('one'), true);
  assert.equal(h.add('one'), false, 'consecutive duplicate collapsed');
  assert.equal(h.add('  '), false, 'blank rejected');
  h.add('two');
  assert.deepEqual(h.entries(), ['one', 'two']);
});

test('in-memory: ring cap', () => {
  const h = new History(null, { max: 3 });
  for (const x of ['a', 'b', 'a', 'c', 'd', 'e']) h.add(x);
  assert.deepEqual(h.entries(), ['c', 'd', 'e']);
});

test('JSONL round-trip: entries survive save + load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-hist-'));
  const file = path.join(dir, 'history.jsonl');
  const h = new History(file, { max: 10 });
  await h.load();
  h.add('first');
  h.add('second');
  await h.flush(); // appends are serialized; wait for the chain
  const h2 = new History(file, { max: 10 });
  await h2.load();
  assert.deepEqual(h2.entries(), ['first', 'second']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('JSONL: corrupt/trailing torn line skipped on load', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-hist-'));
  const file = path.join(dir, 'history.jsonl');
  await fs.writeFile(file,
    JSON.stringify({ ts: 't', text: 'good' }) + '\n'
    + '{"ts":"t","text":"torn'); // torn trailing JSON (no newline)
  const h = new History(file, { max: 10 });
  await h.load();
  assert.deepEqual(h.entries(), ['good']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('JSONL: boot load compacts to the newest max entries — ON DISK TOO', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-hist-'));
  const file = path.join(dir, 'history.jsonl');
  const rows = ['1', '2', '3', '4', '5'].map(t => JSON.stringify({ ts: 't', text: t })).join('\n');
  await fs.writeFile(file, rows + '\n');
  const h = new History(file, { max: 2 });
  await h.load();
  assert.deepEqual(h.entries(), ['4', '5']);
  // The FILE is rewritten compacted as well — memory-only capping let
  // history.jsonl grow forever and made every boot re-parse the whole file.
  const rowsAfter = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(rowsAfter.length, 2, 'disk compacted to max');
  assert.deepEqual(rowsAfter.map((r) => JSON.parse(r).text), ['4', '5']);
  await fs.rm(dir, { recursive: true, force: true });
});

test('JSONL: consecutive duplicates are rewritten away; small overflow stays put (hysteresis)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-hist2-'));
  const file = path.join(dir, 'history.jsonl');
  await fs.writeFile(file, ['a', 'a', 'b'].map((t, i) => JSON.stringify({ ts: 't' + i, text: t })).join('\n') + '\n');
  await new History(file, { max: 10 }).load();
  let rows = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.deepEqual(rows.map((r) => JSON.parse(r).text), ['a', 'b'], 'dups rewritten away');

  // 4 rows under max 3: overflow (1) ≤ 20% of max → no rewrite thrash.
  await fs.writeFile(file, ['a', 'b', 'c', 'd'].map((t, i) => JSON.stringify({ ts: 't' + i, text: t })).join('\n') + '\n');
  const st = await fs.stat(file);
  await new Promise((r) => setTimeout(r, 20));
  await new History(file, { max: 3 }).load();
  assert.equal((await fs.stat(file)).mtimeMs, st.mtimeMs, 'below the hysteresis threshold: untouched');
  rows = (await fs.readFile(file, 'utf8')).trim().split('\n');
  assert.equal(rows.length, 4, 'file keeps all 4 (memory caps at 3)');
  await fs.rm(dir, { recursive: true, force: true });
});

test('historyPath: joins under the given home', () => {
  assert.equal(historyPath('/tmp/hk2home'), path.join('/tmp/hk2home', 'history.jsonl'));
});
