/*-------------------------------------------------------------------------
 *
 * Unit tests for the Supreme Code store (lib/store/supreme_code.js) and its
 * integrations (init self-heal, protection guards, /kb code planning).
 *
 * The supreme-code entry (id `hk2-supreme-code`) is the project's permanent
 * fundamental law: created empty by /kb init, self-healed when missing,
 * never deletable / renamable / auto-updatable, items managed only via
 * /kb code add|del with explicit confirmation.
 *
 * Run:  node --test test/supreme_code.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// kb_store.js caches KB_ROOT at module-load time from HK2_KB_DIR, so the env
// must be set BEFORE the modules are dynamically imported below.
let tmpKbRoot = '';
let origKbDir = '';
let origHome = '';
const PROJECT_ID = 'supreme-code-test';

let supreme, kbStore, registry;

test.before(async () => {
  origKbDir = process.env.HK2_KB_DIR || '';
  origHome = process.env.HK2_HOME || '';
  tmpKbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-supreme-'));
  process.env.HK2_KB_DIR = tmpKbRoot;
  process.env.HK2_HOME = tmpKbRoot;
  supreme = await import('../lib/store/supreme_code.js');
  kbStore = await import('../lib/store/kb_store.js');
  registry = await import('../lib/index/registry.js');
});

test.after(async () => {
  if (origKbDir) process.env.HK2_KB_DIR = origKbDir; else delete process.env.HK2_KB_DIR;
  if (origHome) process.env.HK2_HOME = origHome; else delete process.env.HK2_HOME;
  await fs.rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
});

const mkProject = (pid = PROJECT_ID) => {
  const srcDir = path.join(tmpKbRoot, 'src-' + Math.random().toString(36).slice(2, 8));
  return fs.mkdir(srcDir, { recursive: true }).then(() => ({
    id: pid,
    name: pid,
    sourcePath: srcDir,
  }));
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

test('constants: id, max items, max chars', () => {
  assert.equal(supreme.SUPREME_CODE_ID, 'hk2-supreme-code');
  assert.equal(supreme.SUPREME_CODE_MAX_ITEMS, 100);
  assert.equal(supreme.SUPREME_CODE_MAX_CHARS, 200);
  assert.ok(supreme.isSupremeCode('hk2-supreme-code'));
  assert.ok(!supreme.isSupremeCode('other-entry'));
});

test('normalizeCodes trims, drops empties, caps length/count', () => {
  const out = supreme.normalizeCodes(['  a  ', null, '', 'b'.repeat(500), undefined, ' ok ']);
  assert.deepEqual(out, ['a', 'b'.repeat(200), 'ok']);
  assert.deepEqual(supreme.normalizeCodes(undefined), []);
  const many = supreme.normalizeCodes(Array.from({ length: 150 }, (_, i) => `r${i}`));
  assert.equal(many.length, 100);
});

test('validateCodes flags long / empty / non-string items', () => {
  assert.equal(supreme.validateCodes(['a', 'b']).ok, true);
  const bad = supreme.validateCodes(['a', '', 'x'.repeat(201), 42]);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3);
  assert.ok(bad.errors.some(e => e.reason.includes('item 2: empty')));
  assert.ok(bad.errors.some(e => e.reason.includes('201 chars')));
});

test('validateOneCodeItem normalizes whitespace and enforces limits', () => {
  const ok = supreme.validateOneCodeItem('  API  Key 绝对\n禁止  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'API Key 绝对 禁止');
  const empty = supreme.validateOneCodeItem('   ');
  assert.equal(empty.ok, false);
  const long = supreme.validateOneCodeItem('x'.repeat(201));
  assert.equal(long.ok, false);
  assert.ok(long.reason.includes('201'));
});

test('parseCodeItemId accepts 1..100 only', () => {
  assert.equal(supreme.parseCodeItemId('1'), 1);
  assert.equal(supreme.parseCodeItemId('100'), 100);
  assert.equal(supreme.parseCodeItemId('0'), null);
  assert.equal(supreme.parseCodeItemId('101'), null);
  assert.equal(supreme.parseCodeItemId('abc'), null);
  assert.equal(supreme.parseCodeItemId('2.5'), null);
  assert.equal(supreme.parseCodeItemId(null), null);
});

test('planCodeAdd appends, updates, rejects gaps and overflow', () => {
  const codes = ['one', 'two', 'three'];
  // append (id omitted)
  let r = supreme.planCodeAdd(codes, null, 'four');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'append');
  assert.deepEqual(r.codes, ['one', 'two', 'three', 'four']);
  // explicit append id = count+1
  r = supreme.planCodeAdd(codes, 4, 'four');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'append');
  // update in place
  r = supreme.planCodeAdd(codes, 2, 'TWO');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'update');
  assert.deepEqual(r.codes, ['one', 'TWO', 'three']);
  // input not mutated
  assert.deepEqual(codes, ['one', 'two', 'three']);
  // gap rejected
  r = supreme.planCodeAdd(codes, 5, 'x');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('gap'));
  // capacity rejected
  const full = Array.from({ length: 100 }, (_, i) => `r${i}`);
  r = supreme.planCodeAdd(full, null, 'overflow');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('full'));
  // overlong content rejected
  r = supreme.planCodeAdd(codes, 1, 'y'.repeat(201));
  assert.equal(r.ok, false);
});

test('planCodeDel removes and renumbers (no gaps)', () => {
  const codes = ['a', 'b', 'c', 'd', 'e'];
  // delete #2 → c becomes 2, d 3, e 4
  let r = supreme.planCodeDel(codes, 2);
  assert.equal(r.ok, true);
  assert.equal(r.removed, 'b');
  assert.deepEqual(r.codes, ['a', 'c', 'd', 'e']);
  // input not mutated
  assert.equal(codes.length, 5);
  // out of range
  r = supreme.planCodeDel(codes, 0);
  assert.equal(r.ok, false);
  r = supreme.planCodeDel(codes, 6);
  assert.equal(r.ok, false);
  r = supreme.planCodeDel([], 1);
  assert.equal(r.ok, false);
});

test('sanitizeGeneratedCodeItem strips fences, numbering, quotes, bullets', () => {
  assert.equal(
    supreme.sanitizeGeneratedCodeItem('```\n1. API Key 绝对禁止出现在任何代码文件中\n```'),
    'API Key 绝对禁止出现在任何代码文件中'
  );
  assert.equal(supreme.sanitizeGeneratedCodeItem('2、代码规范必须遵循 KB(project-code-format)'), '代码规范必须遵循 KB(project-code-format)');
  assert.equal(supreme.sanitizeGeneratedCodeItem('"quoted rule"'), 'quoted rule');
  assert.equal(supreme.sanitizeGeneratedCodeItem('- item with bullet'), 'item with bullet');
  assert.equal(supreme.sanitizeGeneratedCodeItem('法条3：禁止 force push'), '禁止 force push');
  assert.equal(supreme.sanitizeGeneratedCodeItem('  spaced   out  '), 'spaced out');
});

test('renderSupremeCodeIntro lists numbered items', () => {
  const intro = supreme.renderSupremeCodeIntro(['first law', 'second law']);
  assert.ok(intro.includes('1. first law'));
  assert.ok(intro.includes('2. second law'));
  assert.ok(intro.includes('/kb code add'));
  const empty = supreme.renderSupremeCodeIntro([]);
  assert.ok(empty.includes('no code items yet'));
});

/* ------------------------------------------------------------------ */
/* Store round-trips                                                   */
/* ------------------------------------------------------------------ */

test('writeSupremeCode / readSupremeCode round-trip preserves codes + createdAt', async () => {
  const pid = 'rt-' + Math.random().toString(36).slice(2, 8);
  const p = await mkProject(pid);
  await registry.addKbForProject(p);
  const { entry, path: written } = await supreme.writeSupremeCode(pid, ['law one', 'law two']);
  assert.ok(written.endsWith('hk2-supreme-code.json'));
  assert.equal(entry.space, 'holy');
  assert.equal(entry.protected, true);
  assert.ok(entry.createdAt);

  const back = await supreme.readSupremeCode(pid);
  assert.deepEqual(back.codes, ['law one', 'law two']);
  assert.equal(back.entry.id, 'hk2-supreme-code');
  const createdAt = back.entry.createdAt;

  // rewrite keeps createdAt and appends
  await supreme.writeSupremeCode(pid, ['law one', 'law two', 'law three']);
  const back2 = await supreme.readSupremeCode(pid);
  assert.equal(back2.entry.codes.length, 3);
  assert.equal(back2.entry.createdAt, createdAt);
});

test('writeSupremeCode throws on invalid items', async () => {
  const pid = 'inv-' + Math.random().toString(36).slice(2, 8);
  await assert.rejects(
    () => supreme.writeSupremeCode(pid, ['x'.repeat(300)]),
    /invalid supreme code items/
  );
  // nothing should have been written
  assert.equal(await supreme.readSupremeCode(pid), null);
});

test('ensureSupremeCode creates once, never overwrites', async () => {
  const pid = 'ensure-' + Math.random().toString(36).slice(2, 8);
  const p = await mkProject(pid);
  await registry.addKbForProject(p);
  // created via addKbForProject's own ensure — see integration test below.
  // Here: explicit ensure then content then ensure again.
  const first = await supreme.ensureSupremeCode(pid);
  assert.deepEqual(first.codes, []);
  await supreme.writeSupremeCode(pid, ['do not clobber']);
  const second = await supreme.ensureSupremeCode(pid);
  assert.equal(second.created, false);
  assert.deepEqual(second.codes, ['do not clobber']);
});

/* ------------------------------------------------------------------ */
/* Integration: /kb init auto-creates the entry                        */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Integration: KBRuntime self-heals a legacy project missing the entry */
/* ------------------------------------------------------------------ */

test('addKbForProject creates an EMPTY supreme-code entry in Holy', async () => {
  const pid = 'fresh-' + Math.random().toString(36).slice(2, 8);
  const srcDir = path.join(tmpKbRoot, 'src-' + pid);
  await fs.mkdir(srcDir, { recursive: true });
  await registry.addKbForProject({ id: pid, name: pid, sourcePath: srcDir });
  const rec = await supreme.readSupremeCode(pid);
  assert.ok(rec, 'supreme-code entry must exist right after addKbForProject');
  assert.deepEqual(rec.codes, []);
  assert.equal(rec.entry.space, 'holy');
  assert.equal(rec.entry.id, 'hk2-supreme-code');
});

test('KBRuntime.load self-heals missing supreme-code entry (legacy project)', async () => {
  const pid = 'legacy-' + Math.random().toString(36).slice(2, 8);
  const dir = path.join(tmpKbRoot, pid);
  await fs.mkdir(path.join(dir, 'holy'), { recursive: true });
  await fs.mkdir(path.join(dir, 'eden'), { recursive: true });
  // Minimal inverted index so KBRuntime.load's first read doesn't throw.
  await fs.writeFile(path.join(dir, 'inverted.json'), JSON.stringify({ N: 0, avgdl: 0, df: {}, docLen: {}, inverted: {} }));
  await fs.writeFile(path.join(dir, 'files.json'), JSON.stringify({ byId: {}, byPath: {}, nextId: 1 }));

  const { getRuntime, dropRuntime } = await import('../lib/retrieval/kb_runtime.js');
  dropRuntime(pid);
  const rt = await getRuntime(pid);
  // Self-healed: entry present in memory + on disk, empty codes.
  assert.deepEqual(rt.supremeCodes, []);
  assert.ok(rt.knowledgeBySpace.holy.some(e => e.id === 'hk2-supreme-code'));
  const onDisk = await supreme.readSupremeCode(pid);
  assert.ok(onDisk);
  assert.deepEqual(onDisk.codes, []);

  // Give it content, reload — must NOT be overwritten.
  await supreme.writeSupremeCode(pid, ['law stays']);
  dropRuntime(pid);
  const rt2 = await getRuntime(pid);
  assert.deepEqual(rt2.supremeCodes, ['law stays']);
  dropRuntime(pid);
});
