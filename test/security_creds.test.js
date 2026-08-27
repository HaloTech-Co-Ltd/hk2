/*-------------------------------------------------------------------------
 *
 * Credential-hygiene regression tests (review round 3, P0):
 *
 *   - history.jsonl NEVER persists secret-bearing inputs (--api-key,
 *     --token, Authorization, password=/secret=) — it must not become a
 *     plaintext key store
 *   - history.jsonl is created 0o600 and an existing group/world-readable
 *     file is tightened on load
 *   - writeFileAtomic enforces 0o600 on the TARGET after the rename — a
 *     pre-existing 0644 file must not keep its wide bits across a rewrite
 *   - ensureHome keeps HK2_HOME 0o700 and models.json/projects.json 0o600
 *
 * Run:  node --test test/security_creds.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { History, historyPath, isSensitiveInput } from '../src/tui/history.js';
import { writeJsonAtomic } from '../lib/util/fs_atomic.js';
import { ensureHome, loadModels, saveModels, HK2_HOME, MODELS_PATH } from '../lib/config/home.js';

const modeOf = async (p) => (await fsp.stat(p)).mode & 0o777;

test('isSensitiveInput: credential-bearing inputs are detected in all documented shapes', () => {
  const yes = [
    '/model add claude m --api-key=sk-ant-123',
    '/model add claude m --api-key sk-ant-123',
    '/model set p/m --api-key=sk-ant-123',
    '/model add p m --token=ghp_xxx',
    'curl -H "Authorization: Bearer sk-ant-123" https://x',
    'export password=hunter2',
    'connect --secret=abc123',
    '/model add p m --API-KEY=sk-ant-123',
    'curl -H "authorization: token ghp_x" https://x',
  ];
  for (const s of yes) assert.equal(isSensitiveInput(s), true, JSON.stringify(s));
  const no = [
    '/model list',
    'why does the wal replay loop hang',
    '怎么配置默认模型',
    '/kb knowledge list --space=holy',
    'read the api-key docs page and summarize', // prose mention, no secret value
  ];
  for (const s of no) assert.equal(isSensitiveInput(s), false, JSON.stringify(s));
});

test('History.add DROPS sensitive inputs — the file never contains the key', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-sec-h-'));
  const file = path.join(dir, 'history.jsonl');
  const h = new History(file, { max: 100 });
  await h.load();
  assert.equal(h.add('/model add claude m --api-key=sk-ant-SECRET'), false, 'sensitive add returns false');
  assert.equal(h.add('normal question'), true);
  await h.flush();
  const raw = await fsp.readFile(file, 'utf8');
  assert.ok(!raw.includes('SECRET'), 'the key never lands in history.jsonl');
  assert.ok(raw.includes('normal question'));
  assert.equal((await modeOf(file)) & 0o077, 0, 'history file is owner-only');
});

test('History.load tightens a pre-existing group-readable history file', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-sec-t-'));
  const file = path.join(dir, 'history.jsonl');
  await fsp.writeFile(file, JSON.stringify({ text: 'old' }) + '\n', { mode: 0o644 });
  await fs.chmodSync(file, 0o644);
  const h = new History(file);
  await h.load();
  assert.equal(await modeOf(file), 0o600, 'migrated to 0600 on load');
});

test('writeFileAtomic: a pre-existing 0644 target is 0600 after the rewrite', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hk2-sec-a-'));
  const file = path.join(dir, 'models.json');
  await fsp.writeFile(file, '{"old":true}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.equal(await modeOf(file), 0o644);
  await writeJsonAtomic(file, { providers: {}, default: null });
  assert.equal(await modeOf(file), 0o600, 'mode re-enforced after rename');
  // Explicit wider mode stays honored when a caller asks for it.
  await writeJsonAtomic(file, { x: 1 }, { mode: 0o644 });
  assert.equal(await modeOf(file), 0o644);
});

test('ensureHome: HK2_HOME 0700, models.json 0600 (created or migrated)', async () => {
  await ensureHome();
  assert.equal(await modeOf(HK2_HOME), 0o700, 'home dir owner-only');
  assert.equal((await modeOf(MODELS_PATH)) & 0o077, 0, 'models.json owner-only');
  // Migration: a wide pre-existing models.json is tightened by the next boot.
  fs.chmodSync(MODELS_PATH, 0o644);
  await ensureHome();
  assert.equal((await modeOf(MODELS_PATH)) & 0o077, 0, 'tightened on ensureHome');
  // And saveModels keeps it that way.
  const data = await loadModels();
  await saveModels(data);
  assert.equal((await modeOf(MODELS_PATH)) & 0o077, 0);
});
