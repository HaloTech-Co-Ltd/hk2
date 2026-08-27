/*-------------------------------------------------------------------------
 *
 * Unit tests for the Claude Code settings import (src/claude_import.js):
 * fill-only bootstrap that registers an anthropic-compatible provider from
 * ~/.claude/settings.json when hk2 has no default model.
 *
 * Run:  node --test test/claude_import.test.js
 *----------------------------------------------------------------------*/
import './_claude_import_setup.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { autoImportClaudeModel, claudeSettingsPath } from '../src/claude_import.js';
import { loadModels, MODELS_PATH } from '../lib/config/home.js';
import { HK2_HOME } from './_claude_import_setup.js';

let claudeHome;

async function reset({ modelsJson = null, claudeEnv = null } = {}) {
  try { await fs.unlink(MODELS_PATH); } catch {}
  if (modelsJson !== null) await fs.writeFile(MODELS_PATH, modelsJson);
  claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-claude-'));
  if (claudeEnv !== null) {
    await fs.mkdir(path.join(claudeHome, '.claude'), { recursive: true });
    await fs.writeFile(claudeSettingsPath(claudeHome), JSON.stringify({ env: claudeEnv }));
  }
}

beforeEach(async () => {
  delete process.env.HK2_AUTOIMPORT_CLAUDE;
});

test('imports provider + default from a Claude Code settings env block', async () => {
  await reset({ claudeEnv: {
    ANTHROPIC_AUTH_TOKEN: 'tok-123',
    ANTHROPIC_BASE_URL: 'https://gw.example/api/anthropic',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5-turbo',
  }});
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, true);
  assert.equal(r.ref, 'claude/glm-5.3');
  assert.deepEqual(r.models, ['glm-5.3', 'glm-5-turbo'], 'hints deduped, sonnet first, no stray seed');

  const saved = await loadModels();
  assert.equal(saved.default, 'claude/glm-5.3');
  const prov = saved.providers.claude;
  assert.equal(prov.api, 'anthropic');
  assert.equal(prov.apiKey, 'tok-123');
  assert.equal(prov.baseUrl, 'https://gw.example/api/anthropic');
  assert.equal(prov.models.length, 2);
  assert.equal(prov.importedFrom, 'claude-settings');
});

test('fill-only: never touches an existing default', async () => {
  await reset({
    modelsJson: JSON.stringify({ providers: { mine: { api: 'openai', apiKey: 'k', models: [{ id: 'x', name: 'x' }] } }, default: 'mine/x' }),
    claudeEnv: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://x/' },
  });
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, false);
  assert.equal(r.reason, 'already-configured');
  const saved = await loadModels();
  assert.equal(saved.default, 'mine/x');
  assert.equal(saved.providers.claude, undefined);
});

test('no Claude settings / no endpoint → no-op', async () => {
  await reset({}); // no .claude dir at all
  let r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, false);
  assert.equal(r.reason, 'no-claude-settings');

  await reset({ claudeEnv: { SOMETHING: 'else' } }); // settings but no endpoint
  r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, false);
  assert.equal(r.reason, 'no-anthropic-endpoint');
});

test('HK2_AUTOIMPORT_CLAUDE=0 disables the import', async () => {
  await reset({ claudeEnv: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://x/' } });
  process.env.HK2_AUTOIMPORT_CLAUDE = '0';
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, false);
  assert.equal(r.reason, 'disabled');
});

test('ANTHROPIC_API_KEY works when AUTH_TOKEN is absent', async () => {
  await reset({ claudeEnv: {
    ANTHROPIC_API_KEY: 'sk-abc',
    ANTHROPIC_BASE_URL: 'https://api.example/v1',
  }});
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, true);
  const saved = await loadModels();
  assert.equal(saved.providers.claude.apiKey, 'sk-abc');
});

test('fallback seed model when no DEFAULT_*_MODEL hints exist', async () => {
  await reset({ claudeEnv: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://x/' } });
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, true);
  assert.equal(r.ref, 'claude/claude-sonnet-4-6');
});

test('provider-exists: a user-configured claude provider is never overwritten', async () => {
  await reset({
    modelsJson: JSON.stringify({ providers: { claude: { api: 'openai', apiKey: 'keep', baseUrl: 'https://keep' } }, default: null }),
    claudeEnv: { ANTHROPIC_AUTH_TOKEN: 'new', ANTHROPIC_BASE_URL: 'https://new' },
  });
  const r = await autoImportClaudeModel({ homeDir: claudeHome });
  assert.equal(r.imported, false);
  assert.equal(r.reason, 'provider-exists');
  const saved = await loadModels();
  assert.equal(saved.providers.claude.api, 'openai');
  assert.equal(saved.providers.claude.apiKey, 'keep');
  assert.equal(saved.providers.claude.baseUrl, 'https://keep');
});
