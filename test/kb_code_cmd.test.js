/* Smoke test for /kb code commands via cmdKb dispatch (mocked ctx).
 * Run: HK2_KB_DIR set inside; node test/kb_code_cmd.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

let tmpKbRoot = '';
let origKbDir = '';
let origHome = '';
const PID = 'kb-code-cmd-test';

test.before(async () => {
  origKbDir = process.env.HK2_KB_DIR || '';
  origHome = process.env.HK2_HOME || '';
  tmpKbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-codecmd-'));
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

function mockCtx({ confirmAnswer = true, llm = null } = {}) {
  const output = [];
  return {
    output,
    print: (s) => output.push(String(s)),
    confirm: async () => confirmAnswer,
    getCurrentProject: async () => ({ id: PID, name: PID }),
    llm,
    noteReloadKb: () => {},
  };
}

test('kb code add/list/del happy path + protections', async () => {
  const { cmdKb } = await import('../src/slash/kb.js');
  const { addKbForProject } = await import('../lib/index/registry.js');
  await addKbForProject({ id: PID, name: PID, sourcePath: path.join(tmpKbRoot, 'src') });
  const { readSupremeCode } = await import('../lib/store/supreme_code.js');

  // list (empty)
  let ctx = mockCtx();
  await cmdKb(['code', 'list'], ctx);
  assert.ok(ctx.output.some(l => l.includes('0/100')), 'empty list header');

  // add #1 (verbatim content, append)
  ctx = mockCtx({ confirmAnswer: true });
  await cmdKb(['code', 'add', '--code-content=API Key 绝对禁止出现在任何代码文件中'], ctx);
  assert.ok(ctx.output.some(l => l.includes('APPEND as item 1')), 'append preview');
  let rec = await readSupremeCode(PID);
  assert.deepEqual(rec.codes, ['API Key 绝对禁止出现在任何代码文件中']);

  // add #2 referencing a KB entry
  ctx = mockCtx();
  await cmdKb(['code', 'add', '--code-content=代码规范必须严格遵循 **KB(project-code-format)**'], ctx);
  rec = await readSupremeCode(PID);
  assert.equal(rec.codes.length, 2);
  assert.ok(rec.codes[1].includes('KB(project-code-format)'));

  // update #1 in place
  ctx = mockCtx();
  await cmdKb(['code', 'add', '1', '--code-content=密钥类敏感信息禁止硬编码'], ctx);
  assert.ok(ctx.output.some(l => l.includes('UPDATE item 1')), 'update preview');
  rec = await readSupremeCode(PID);
  assert.equal(rec.codes[0], '密钥类敏感信息禁止硬编码');
  assert.equal(rec.codes.length, 2);

  // reject gap (id 4 when count=2)
  ctx = mockCtx();
  await cmdKb(['code', 'add', '4', '--code-content=x'], ctx);
  assert.ok(ctx.output.some(l => l.includes('gap')), 'gap rejected');

  // reject overlong
  ctx = mockCtx();
  await cmdKb(['code', 'add', '--code-content=' + 'y'.repeat(201)], ctx);
  assert.ok(ctx.output.some(l => l.includes('chars')), 'overlong rejected');

  // reject both flags
  ctx = mockCtx();
  await cmdKb(['code', 'add', '--code-content=a', '--code-gen=b'], ctx);
  assert.ok(ctx.output.some(l => l.includes('ONE of')), 'mutually exclusive');

  // decline confirm → no write
  ctx = mockCtx({ confirmAnswer: false });
  await cmdKb(['code', 'add', '--code-content=never written'], ctx);
  rec = await readSupremeCode(PID);
  assert.ok(!rec.codes.includes('never written'));

  // del #1 → renumber
  ctx = mockCtx();
  await cmdKb(['code', 'del', '1'], ctx);
  rec = await readSupremeCode(PID);
  assert.equal(rec.codes.length, 1);
  assert.equal(rec.codes[0], '代码规范必须严格遵循 **KB(project-code-format)**');

  // del invalid id
  ctx = mockCtx();
  await cmdKb(['code', 'del', '9'], ctx);
  assert.ok(ctx.output.some(l => l.includes('invalid code-id')));

  // list shows the item
  ctx = mockCtx();
  await cmdKb(['code', 'list'], ctx);
  assert.ok(ctx.output.some(l => l.includes('1/100')), 'list count');
  assert.ok(ctx.output.some(l => l.includes('project-code-format')));
});

test('knowledge del / transform / add refuse to touch the supreme code', async () => {
  const { cmdKb } = await import('../src/slash/kb.js');
  // knowledge del
  let ctx = mockCtx();
  await cmdKb(['knowledge', 'del', 'hk2-supreme-code'], ctx);
  assert.ok(ctx.output.some(l => l.includes('deletion is not allowed')), 'knowledge del refused');
  // transform
  ctx = mockCtx();
  await cmdKb(['transform', 'hk2-supreme-code', 'holy', 'eden'], ctx);
  assert.ok(ctx.output.some(l => l.includes('cannot be moved')), 'transform refused');
  // knowledge add with reserved id
  ctx = mockCtx();
  await cmdKb(['knowledge', 'add', '--id=hk2-supreme-code', '--title=x', '--intro=y'], ctx);
  assert.ok(ctx.output.some(l => l.includes('reserved')), 'knowledge add refused');
});

test('kb code add --code-gen uses the provided LLM and confirms before write', async () => {
  const { cmdKb } = await import('../src/slash/kb.js');
  const { readSupremeCode } = await import('../lib/store/supreme_code.js');
  const fakeLlm = {
    complete: async (msgs) => {
      assert.ok(String(msgs[0].content).includes('Supreme Code'));
      return '```markdown\n1. 禁止在未确认的情况下删除任何数据库\n```';
    },
  };
  const ctx = mockCtx({ llm: fakeLlm, confirmAnswer: true });
  await cmdKb(['code', 'add', '--code-gen=一条关于数据库安全的法条'], ctx);
  assert.ok(ctx.output.some(l => l.includes('drafting')), 'gen step ran');
  const rec = await readSupremeCode(PID);
  assert.ok(rec.codes.includes('禁止在未确认的情况下删除任何数据库'), 'sanitized item written');
});
