import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    await fs.rm(home, { recursive: true, force: true });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HK2_HOME: '', HK2_KB_DIR: '' },
  });
  assert.match(output, /kb dir:\s+.*custom-kb-root[\\/]status-project[\\/]/);
  assert.ok(!output.includes('~/.hk2/kb/status-project'));
});
