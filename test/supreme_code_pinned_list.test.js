/* Regression: /kb knowledge list must pin the permanent supreme-code entry
 * (hk2-supreme-code) to the TOP of the Holy space list, regardless of the
 * underlying readdir ordering, and annotate it.
 * Run: HK2_KB_DIR set inside; node test/supreme_code_pinned_list.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let tmpKbRoot = '';
let origKbDir = '';
let origHome = '';
const PID = 'kb-supreme-pin-test';

test.before(async () => {
  origKbDir = process.env.HK2_KB_DIR || '';
  origHome = process.env.HK2_HOME || '';
  tmpKbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-sc-pin-'));
  process.env.HK2_KB_DIR = tmpKbRoot;
  process.env.HK2_HOME = tmpKbRoot;

  const srcDir = path.join(tmpKbRoot, 'src');
  await fs.mkdir(srcDir, { recursive: true });
});

test.after(async () => {
  if (origKbDir) process.env.HK2_KB_DIR = origKbDir; else delete process.env.HK2_KB_DIR;
  if (origHome) process.env.HK2_HOME = origHome; else delete process.env.HK2_HOME;
  await fs.rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
});

function mockCtx() {
  const output = [];
  return {
    output,
    print: (s) => output.push(String(s)),
    confirm: async () => true,
    getCurrentProject: async () => ({ id: PID, name: PID }),
    llm: null,
    noteReloadKb: () => {},
  };
}

test('/kb knowledge list pins supreme-code first in Holy space', async () => {
  const { cmdKb } = await import('../src/slash/kb.js');
  const { addKbForProject } = await import('../lib/index/registry.js');
  const { writeKnowledge, listKnowledge } = await import('../lib/store/kb_store.js');

  await addKbForProject({ id: PID, name: PID, sourcePath: path.join(tmpKbRoot, 'src') });

  // Add alphabetically-BEFORE entries to both spaces, so the raw readdir
  // order would place them ahead of "hk2-supreme-code".
  await writeKnowledge(PID, 'holy', {
    id: 'aaa-alpha-principle', title: 'AAA Alpha Principle', space: 'holy',
    intro: 'alpha', keywords: ['alpha'], keyFiles: [], keySymbols: [],
  });
  await writeKnowledge(PID, 'holy', {
    id: 'bbb-beta-principle', title: 'BBB Beta Principle', space: 'holy',
    intro: 'beta', keywords: ['beta'], keyFiles: [], keySymbols: [],
  });
  await writeKnowledge(PID, 'eden', {
    id: 'eden-notes', title: 'Eden Notes', space: 'eden',
    intro: 'notes', keywords: ['notes'], keyFiles: [], keySymbols: [],
  });

  // Sanity: store-level order is NOT pinned (display-layer concern only).
  const raw = await listKnowledge(PID, 'holy');
  assert.ok(raw.some(e => e.id === 'hk2-supreme-code'), 'supreme-code entry exists');

  // Full list (both spaces)
  const ctx = mockCtx();
  await cmdKb(['knowledge', 'list'], ctx);
  const lines = ctx.output;

  // Holy header and its entries
  const holyHeaderIdx = lines.findIndex(l => l.startsWith('[holy]'));
  const edenHeaderIdx = lines.findIndex(l => l.startsWith('[eden]'));
  assert.ok(holyHeaderIdx >= 0, 'holy header printed');
  assert.ok(edenHeaderIdx > holyHeaderIdx, 'eden block after holy block');

  const holyEntryLines = lines.filter((l, i) =>
    i > holyHeaderIdx && i < edenHeaderIdx && /^\s{2}\S/.test(l));
  assert.equal(holyEntryLines.length, 3, 'three holy entries listed');
  assert.match(holyEntryLines[0], /^  📌 hk2-supreme-code/, 'supreme-code pinned first with pushpin');
  assert.match(holyEntryLines[0], /supreme code \(permanent/, 'annotation present');
  assert.match(holyEntryLines[1], /^  aaa-alpha-principle/, 'remaining order preserved (1)');
  assert.doesNotMatch(holyEntryLines[1], /📌/, 'no pushpin on ordinary entries (1)');
  assert.match(holyEntryLines[2], /^  bbb-beta-principle/, 'remaining order preserved (2)');
  assert.doesNotMatch(holyEntryLines[2], /📌/, 'no pushpin on ordinary entries (2)');

  // Eden must NOT be reordered or annotated
  const edenEntryLines = lines.filter((l, i) => i > edenHeaderIdx && /^\s{2}\S/.test(l));
  assert.equal(edenEntryLines.length, 1);
  assert.match(edenEntryLines[0], /^  eden-notes/);
  assert.doesNotMatch(edenEntryLines[0], /supreme code/);
  assert.doesNotMatch(edenEntryLines[0], /📌/);

  // --space=holy filter also pins first
  const ctx2 = mockCtx();
  await cmdKb(['knowledge', 'list', '--space=holy'], ctx2);
  const entryLines2 = ctx2.output.filter(l => /^\s{2}\S/.test(l));
  assert.equal(entryLines2.length, 3);
  assert.match(entryLines2[0], /^  📌 hk2-supreme-code/);
});

test('/kb knowledge list with empty supreme-code still pins (shell only)', async () => {
  // A KB whose supreme-code entry has zero items must still list the entry
  // (it is permanent and self-healed), pinned to the top.
  const { cmdKb } = await import('../src/slash/kb.js');
  const { readSupremeCode } = await import('../lib/store/supreme_code.js');

  const rec = await readSupremeCode(PID);
  assert.ok(rec, 'supreme-code entry readable');
  // (items were never added in this project — shell only)

  const ctx = mockCtx();
  await cmdKb(['knowledge', 'list', '--space=holy'], ctx);
  const entryLines = ctx.output.filter(l => /^\s{2}\S/.test(l));
  assert.ok(entryLines.length >= 1);
  assert.match(entryLines[0], /^  📌 hk2-supreme-code/);
});
