import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

test('/kb status displays the effective HK2_KB_DIR path', () => {
  const repo = path.resolve(process.cwd());
  const script = `
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-status-'));
    const custom = path.join(home, 'custom-kb-root');
    process.env.HK2_HOME = home;
    process.env.HK2_KB_DIR = custom;
    const { cmdKb } = await import(${JSON.stringify(path.join(repo, 'src/slash/kb.js'))});
    const id = 'status-project';
    await fs.mkdir(path.join(custom, id), { recursive: true });
    await fs.writeFile(path.join(custom, id, 'meta.json'), JSON.stringify({
      sourcePath: '/tmp/example-project', sourceRoot: '', updatedAt: 'now'
    }));
    const output = [];
    await cmdKb(['status'], {
      getCurrentProject: async () => ({ id, name: 'status-project' }),
      print: (line) => output.push(String(line)),
    });
    console.log(output.join('\\n'));
    console.log('selfheal=' + await fs.readFile(path.join(custom, id, 'holy', 'hk2-supreme-code.json'), 'utf8'));
    await fs.rm(home, { recursive: true, force: true });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HK2_HOME: '', HK2_KB_DIR: '' },
  });
  assert.match(output, /kb dir:\s+.*custom-kb-root[\\/]status-project[\\/]/);
  assert.ok(!output.includes('~/.hk2/kb/status-project'));
  const selfheal = output.match(/selfheal=(\{.*\})/s);
  assert.ok(selfheal, 'status should create a self-healed entry');
  const parsed = JSON.parse(selfheal[1]);
  assert.equal(parsed.id, 'hk2-supreme-code');
  assert.deepEqual(parsed.codes, []);
  assert.equal(parsed.protected, true);
  assert.equal(parsed.permanent, true);
});

test('/kb status does not rewrite an existing Supreme Code entry', () => {
  const repo = path.resolve(process.cwd());
  const script = `
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-status-existing-'));
    const custom = path.join(home, 'kb-root');
    process.env.HK2_HOME = home; process.env.HK2_KB_DIR = custom;
    const id = 'existing-project';
    const dir = path.join(custom, id);
    await fs.mkdir(path.join(dir, 'holy'), { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ sourcePath: '/tmp/example-project' }));
    const file = path.join(dir, 'holy', 'hk2-supreme-code.json');
    const before = JSON.stringify({ id: 'hk2-supreme-code', title: 'Supreme Code', intro: '', codes: ['rule'], protected: true, permanent: true });
    await fs.writeFile(file, before);
    const oldMtime = new Date('2020-01-02T03:04:05.678Z');
    await fs.utimes(file, oldMtime, oldMtime);
    const beforeStat = await fs.stat(file);
    const { cmdKb } = await import(${JSON.stringify(path.join(repo, 'src/slash/kb.js'))});
    await cmdKb(['status'], { getCurrentProject: async () => ({ id, name: id }), print: () => {} });
    const stat = await fs.stat(file);
    console.log(JSON.stringify({ bytes: await fs.readFile(file, 'utf8'), beforeMtimeMs: beforeStat.mtimeMs, mtimeMs: stat.mtimeMs }));
    await fs.rm(home, { recursive: true, force: true });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: repo, encoding: 'utf8', env: { ...process.env, HK2_HOME: '', HK2_KB_DIR: '' } });
  const result = JSON.parse(output.trim());
  assert.equal(result.bytes, JSON.stringify({ id: 'hk2-supreme-code', title: 'Supreme Code', intro: '', codes: ['rule'], protected: true, permanent: true }));
  assert.equal(result.mtimeMs, result.beforeMtimeMs, 'status did not rewrite the file or touch its mtime');
});

test('/kb status continues quietly when Supreme Code self-heal cannot write', () => {
  const repo = path.resolve(process.cwd());
  const script = `
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-status-failure-'));
    const custom = path.join(home, 'kb-root');
    process.env.HK2_HOME = home; process.env.HK2_KB_DIR = custom;
    const id = 'failure-project';
    const dir = path.join(custom, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ sourcePath: '/tmp/example-project' }));
    await fs.writeFile(path.join(dir, 'holy'), 'not a directory');
    const { cmdKb } = await import(${JSON.stringify(path.join(repo, 'src/slash/kb.js'))});
    const output = [];
    await cmdKb(['status'], { getCurrentProject: async () => ({ id, name: id }), print: (line) => output.push(String(line)) });
    console.log(JSON.stringify(output));
    await fs.rm(home, { recursive: true, force: true });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HK2_HOME: '', HK2_KB_DIR: '' },
  });
  const lines = JSON.parse(output.trim());
  assert.ok(lines.some(line => line.includes('project: failure-project')));
  assert.ok(lines.some(line => line.includes('Supreme Code: 0/')));
  assert.ok(!lines.some(line => /self-heal|cannot write|EISDIR|failure/i.test(line) && !line.includes('failure-project')),
    `self-heal failure should not be separately reported: ${JSON.stringify(lines)}`);
});

test('legacy one-shot build-kb reports the effective custom KB root', () => {
  const repo = path.resolve(process.cwd());
  const script = `
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-build-path-'));
    const source = path.join(home, 'project');
    const custom = path.join(home, 'custom-kb');
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'index.js'), 'export function demo() { return 1; }\\n');
    process.env.HK2_HOME = home; process.env.HK2_KB_DIR = custom; process.env.HK2_KB_NAME = 'one-shot';
    const { buildKb } = await import(${JSON.stringify(path.join(repo, 'src/commands/build_kb.js'))});
    await buildKb({ source });
    await fs.rm(home, { recursive: true, force: true });
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, HK2_HOME: '', HK2_KB_DIR: '', HK2_KB_NAME: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  const output = `${run.stdout}\n${run.stderr}`;
  assert.match(output, /kb dir: .*custom-kb[\\/]one-shot[\\/]/);
  assert.equal(output.includes('~/.hk2/kb/one-shot'), false);
});
