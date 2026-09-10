/*-------------------------------------------------------------------------
 * Regression test: install.sh reinstall must PRESERVE user data (#2).
 *
 * History: INSTALL_DIR defaulted to ~/.hk2 — the same directory lib/config/
 * home.js uses as HK2_HOME for user data (models.json, projects.json, kb/,
 * sessions/, logs/, theme.json). Re-running ./install.sh from a source
 * checkout did `rm -rf ~/.hk2`, wiping every KB (incl. Holy Space), model
 * config (incl. API keys) and session history before copying the code tree
 * back in. No confirmation, no backup.
 *
 * This suite pins three behaviors:
 *   1. Default reinstall: all user-data items survive (moved aside, then
 *      restored on top of the fresh copy).
 *   2. Custom HK2_INSTALL_DIR: ~/.hk2 user data is never touched even
 *      without --preserve-data=off, because the reinstall target is
 *      elsewhere (the preserve logic must not fire on an unrelated dir).
 *   3. --preserve-data=off restores the legacy wipe behavior explicitly.
 *
 * Run:  node --test test/install_preserve_data.test.js
 * ----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

async function mkdtemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
}

/** Minimal fake source tree carrying a COPY of install.sh: SCRIPT_DIR is
 * resolved from the invoked script path, so copying install.sh into the fake
 * tree keeps the test hermetic (no dependence on the real repo contents)
 * while still exercising the real script under test. */
async function fakeSourceTree(parent) {
  const src = path.join(parent, 'src-repo');
  await writeTree(src, {
    'bin/hk2': '#!/bin/sh\necho fake-hk2\n',
    'package.json': JSON.stringify({ name: 'hk2', version: 'test' }),
    'lib/config/home.js': 'export const HK2_HOME = "~/.hk2";\n',
    'config/install-data-items.txt': await fs.readFile(path.join(REPO_ROOT, 'config/install-data-items.txt'), 'utf8'),
  });
  await fs.chmod(path.join(src, 'bin/hk2'), 0o755);
  await fs.copyFile(INSTALL_SH, path.join(src, 'install.sh'));
  return src;
}

async function runInstall(src, env, args = []) {
  execFileSync('sh', [path.join(src, 'install.sh'), '--no-npm-install', ...args], {
    cwd: src,
    env: {
      ...process.env,
      ...env,
      HOME: env.HOME,
      HK2_INSTALL_DIR: env.HK2_INSTALL_DIR,
      HK2_PREFIX: env.HK2_PREFIX,
      // Keep only system essentials so `npm` is not found (the script would
      // otherwise run a real npm install inside the sandbox); --no-npm-install
      // above is the deterministic belt, this is the suspenders.
      PATH: '/bin:/usr/bin',
    },
    stdio: 'pipe',
  });
}

/** Seed ~/.hk2 (or $HK2_INSTALL_DIR) with the full user-data contract. */
async function seedUserData(root) {
  await writeTree(root, {
    'models.json': JSON.stringify({ providers: {}, default: null, marker: 'user-models' }),
    'projects.json': JSON.stringify({ projects: [], current: null, marker: 'user-projects' }),
    'theme.json': JSON.stringify({ theme: 'dark', marker: 'user-theme' }),
    'setting.json': JSON.stringify({ permissions: [{ path: '/secret', deny: 'rwx' }] }),
    'history.jsonl': '{"ts":"x","text":"important command"}\n',
    'welcome-seen': '1\n',
    'settings/proj/setting.json': JSON.stringify({ permissions: [{ path: 'private', deny: 'r' }] }),
    'kb/proj/holy/supreme.md': '# Supreme\n',
    'sessions/proj/s1.jsonl': '{"type":"user"}\n',
    'logs/hk2.log': 'log line\n',
  });
}

test('reinstall preserves all user-data items in the default install dir', async () => {
  const tmp = await mkdtemp('hk2-install-preserve-');
  const home = path.join(tmp, 'home');
  const prefix = path.join(tmp, 'prefix');
  await fs.mkdir(home, { recursive: true });
  const src = await fakeSourceTree(tmp);
  const installDir = path.join(home, '.hk2');

  // First install creates the install dir.
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
  // User accumulates data.
  await seedUserData(installDir);

  // Reinstall from the source tree — the P0 data-loss path.
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });

  assert.equal(JSON.parse(await fs.readFile(path.join(installDir, 'models.json'), 'utf8')).marker, 'user-models');
  assert.equal(JSON.parse(await fs.readFile(path.join(installDir, 'projects.json'), 'utf8')).marker, 'user-projects');
  assert.equal(JSON.parse(await fs.readFile(path.join(installDir, 'theme.json'), 'utf8')).marker, 'user-theme');
  assert.ok((await fs.readFile(path.join(installDir, 'setting.json'), 'utf8')).includes('/secret'));
  assert.ok((await fs.readFile(path.join(installDir, 'history.jsonl'), 'utf8')).includes('important command'));
  assert.equal(await fs.readFile(path.join(installDir, 'welcome-seen'), 'utf8'), '1\n');
  assert.ok((await fs.readFile(path.join(installDir, 'settings/proj/setting.json'), 'utf8')).includes('private'));
  assert.equal(await fs.readFile(path.join(installDir, 'kb/proj/holy/supreme.md'), 'utf8'), '# Supreme\n');
  assert.ok((await fs.readFile(path.join(installDir, 'sessions/proj/s1.jsonl'), 'utf8')).includes('"type":"user"'));
  assert.ok((await fs.readFile(path.join(installDir, 'logs/hk2.log'), 'utf8')).length > 0);
  // Fresh code tree present too.
  assert.ok(await fs.stat(path.join(installDir, 'bin/hk2')).then((s) => s.isFile()).catch(() => false));
  // No leftover staging dir.
  await assert.rejects(() => fs.stat(`${installDir}.hk2-preserve`));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('custom HK2_INSTALL_DIR never touches ~/.hk2 user data', async () => {
  const tmp = await mkdtemp('hk2-install-custom-');
  const home = path.join(tmp, 'home');
  const prefix = path.join(tmp, 'prefix');
  await fs.mkdir(home, { recursive: true });
  const src = await fakeSourceTree(tmp);
  const custom = path.join(tmp, 'custom-install');
  // User data lives in ~/.hk2 (HK2_HOME default), install goes elsewhere.
  await seedUserData(path.join(home, '.hk2'));

  // First install + reinstall to the custom dir.
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: custom, HK2_PREFIX: prefix });
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: custom, HK2_PREFIX: prefix });

  // ~/.hk2 untouched: all markers still there.
  const models = JSON.parse(await fs.readFile(path.join(home, '.hk2', 'models.json'), 'utf8'));
  assert.equal(models.marker, 'user-models');
  assert.ok(await fs.stat(path.join(home, '.hk2', 'kb/proj/holy/supreme.md')).then((s) => s.isFile()).catch(() => false));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('--preserve-data=off keeps the explicit wipe behavior', async () => {
  const tmp = await mkdtemp('hk2-install-wipe-');
  const home = path.join(tmp, 'home');
  const prefix = path.join(tmp, 'prefix');
  await fs.mkdir(home, { recursive: true });
  const src = await fakeSourceTree(tmp);
  const installDir = path.join(home, '.hk2');

  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
  await seedUserData(installDir);

  // Legacy behavior, explicitly opted out.
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix }, ['--preserve-data=off', '--confirm-data-loss']);

  await assert.rejects(() => fs.stat(path.join(installDir, 'models.json')));
  await assert.rejects(() => fs.stat(path.join(installDir, 'kb')));
  // Code tree is still installed.
  assert.ok(await fs.stat(path.join(installDir, 'bin/hk2')).then((s) => s.isFile()).catch(() => false));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('--preserve-data=off requires an explicit data-loss confirmation', async () => {
  const tmp = await mkdtemp('hk2-install-confirm-');
  const home = path.join(tmp, 'home');
  const src = await fakeSourceTree(tmp);
  await fs.mkdir(home, { recursive: true });
  await assert.rejects(() => runInstall(src, {
    HOME: home, HK2_INSTALL_DIR: path.join(home, '.hk2'), HK2_PREFIX: path.join(tmp, 'prefix'),
  }, ['--preserve-data=off']));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('an existing preserve directory is recovered instead of deleted', async () => {
  const tmp = await mkdtemp('hk2-install-existing-preserve-');
  const home = path.join(tmp, 'home');
  const prefix = path.join(tmp, 'prefix');
  const src = await fakeSourceTree(tmp);
  const installDir = path.join(home, '.hk2');
  await writeTree(`${installDir}.hk2-preserve`, {
    'models.json': '{"marker":"critical"}\n',
    'kb/demo/data': 'knowledge\n',
  });
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
  assert.ok((await fs.readFile(path.join(installDir, 'models.json'), 'utf8')).includes('critical'));
  assert.equal(await fs.readFile(path.join(installDir, 'kb/demo/data'), 'utf8'), 'knowledge\n');
  await fs.rm(tmp, { recursive: true, force: true });
});

for (const failAt of ['after-stage-copy', 'after-data-move', 'after-old-tree-move', 'after-new-tree-move', 'during-data-restore']) {
  test(`interrupted install at ${failAt} recovers all persistent data on retry`, async () => {
    const tmp = await mkdtemp('hk2-install-interrupt-');
    const home = path.join(tmp, 'home');
    const prefix = path.join(tmp, 'prefix');
    const src = await fakeSourceTree(tmp);
    const installDir = path.join(home, '.hk2');
    await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
    await seedUserData(installDir);
    await assert.rejects(() => runInstall(src, {
      HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix,
      HK2_INSTALL_TEST_FAIL_AT: failAt,
    }));
    await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
    assert.equal(JSON.parse(await fs.readFile(path.join(installDir, 'models.json'), 'utf8')).marker, 'user-models');
    assert.ok((await fs.readFile(path.join(installDir, 'setting.json'), 'utf8')).includes('/secret'));
    assert.ok((await fs.readFile(path.join(installDir, 'history.jsonl'), 'utf8')).includes('important command'));
    assert.equal(await fs.readFile(path.join(installDir, 'kb/proj/holy/supreme.md'), 'utf8'), '# Supreme\n');
    await fs.rm(tmp, { recursive: true, force: true });
  });
}

test('dangerous install directories are rejected before copying', async () => {
  const tmp = await mkdtemp('hk2-install-danger-');
  const home = path.join(tmp, 'home');
  const src = await fakeSourceTree(tmp);
  await fs.mkdir(home, { recursive: true });
  const base = { HOME: home, HK2_PREFIX: path.join(tmp, 'prefix') };
  await assert.rejects(() => runInstall(src, {
    ...base, HK2_INSTALL_DIR: path.join(home, '.hk2'),
  }, ['--install-dir=']), 'must reject an explicitly empty target');
  for (const target of ['/', home, path.join(src, 'nested'), tmp]) {
    await assert.rejects(() => runInstall(src, { ...base, HK2_INSTALL_DIR: target }), `must reject ${JSON.stringify(target)}`);
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

test('reinstall leaves no .git / node_modules in the installed copy', async () => {
  const tmp = await mkdtemp('hk2-install-exclude-');
  const home = path.join(tmp, 'home');
  const prefix = path.join(tmp, 'prefix');
  await fs.mkdir(home, { recursive: true });
  const src = await fakeSourceTree(tmp);
  await writeTree(src, {
    '.git/config': '[core]\n',
    'node_modules/leftover/index.js': '// dev junk\n',
  });
  const installDir = path.join(home, '.hk2');

  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });
  await seedUserData(installDir);
  await runInstall(src, { HOME: home, HK2_INSTALL_DIR: installDir, HK2_PREFIX: prefix });

  await assert.rejects(() => fs.stat(path.join(installDir, '.git')));
  await assert.rejects(() => fs.stat(path.join(installDir, 'node_modules')));
  assert.equal(await fs.readFile(path.join(installDir, 'models.json'), 'utf8'), JSON.stringify({ providers: {}, default: null, marker: 'user-models' }));
  await fs.rm(tmp, { recursive: true, force: true });
});
