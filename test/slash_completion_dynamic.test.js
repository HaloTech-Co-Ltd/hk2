/*-------------------------------------------------------------------------*/

/**
 * Regression tests for DYNAMIC slash-command argument completion.
 *
 * Static completion (command / subcommand names from SLASH_COMMANDS +
 * HELP_TEXT) existed before; these tests cover the data-driven argument
 * positions added on top:
 *
 *   /model use|set|del|set-default [current]|set-phase|add-mcpserver <ref>
 *     → provider/id refs from models.json
 *   /model set-phase --phase=<name> → the phase enum
 *   /session resume|info <id>, /resume <id> → stored session ids
 *   /project set current <id>, /project drop <id> → registered projects
 *
 * Contract under test (src/slash/completions.js + slashCompletions' dyn
 * parameter):
 *   - dynamicSlot() maps ONLY true argument positions (flags, extra
 *     positionals, unknown subs → null)
 *   - slashCompletions(line, dyn) renders labels from the snapshot with
 *     prefix filtering; without a snapshot it keeps the legacy EMPTY
 *     behavior (no invention)
 *   - fetchDynamicItems() loads real models.json / sessions dir /
 *     projects.json under a sandbox HK2_HOME, TTL-caches, and degrades to
 *     [] on any failure (menu never throws)
 *   - invalidateDynamicCache() forces the next fetch to re-read
 *
 * Run:  node --test test/slash_completion_dynamic.test.js
 *-----------------------------------------------------------------------*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The modules read HK2_HOME at import time, so point them at a sandbox
// BEFORE the first dynamic import of home.js / completions.js.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hk2-dyncomp-'));
process.env.HK2_HOME = HOME;

const { slashCompletions } = await import('../src/slash/index.js');
const {
  dynamicSlot, dynamicContextKey, fetchDynamicItems,
  invalidateDynamicCache, currentDynamicSnapshot,
} = await import('../src/slash/completions.js');
const { saveModels, saveProjects, SESSIONS_ROOT } = await import('../lib/config/home.js');

/* -------------------------------------------------- fixtures */

before(async () => {
  await saveModels({
    default: 'openai/gpt-4o',
    providers: {
      openai: {
        api: 'openai', apiKey: 'k', baseUrl: 'https://x/v1',
        models: [
          { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
          { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000 },
        ],
      },
      deepseek: {
        api: 'openai', apiKey: 'k', baseUrl: 'https://y/v1',
        models: [{ id: 'deepseek-v4-flash[1m]', contextWindow: 128000 }],
      },
    },
  });
  await saveProjects({
    current: null,
    projects: {
      'proj-alpha-1': { id: 'proj-alpha-1', name: 'alpha', sourcePath: '/w/alpha' },
      'proj-beta-2': { id: 'proj-beta-2', name: 'beta project', sourcePath: '/w/beta' },
    },
  });
  // Two stored sessions for proj-alpha-1 (newest first).
  const dir = path.join(SESSIONS_ROOT, 'proj-alpha-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'older.jsonl'), '{"type":"user","text":"hi"}\n');
  fs.writeFileSync(path.join(dir, 'newer.jsonl'), '{"type":"user","text":"yo"}\n');
  const past = (h) => new Date(Date.now() - h * 3600_000).getTime();
  fs.utimesSync(path.join(dir, 'older.jsonl'), new Date(past(5)), new Date(past(5)));
  fs.utimesSync(path.join(dir, 'newer.jsonl'), new Date(past(1)), new Date(past(1)));
});

/* -------------------------------------------------- dynamicSlot */

test('dynamicSlot: maps every model-ref argument position', () => {
  for (const line of [
    '/model use ', '/model set ', '/model del ', '/model add-mcpserver ',
    '/model set-default ', '/model set-default current ',
    '/model set-phase ',
  ]) {
    assert.deepEqual(dynamicSlot(line.split(/\s+/)), { kind: 'models', index: line.trim().split(/\s+/).length }, line);
  }
});

test('dynamicSlot: flags and non-argument positions are NOT dynamic', () => {
  for (const line of [
    '/model use --api=', '/model set openai/gpt-4o --name=x', '/model list',
    '/model add openai new-model', '/session new', '/project list', '/kb status',
    '/model set-phase --phase=code-review', // no trailing space → fragment is the flag itself
  ]) {
    assert.equal(dynamicSlot(line.split(/\s+/)), null, line);
  }
});

test('dynamicSlot: set-phase ref after the flag', () => {
  // '/model set-phase --phase=code-review ' → ref is the LAST positional.
  const t = '/model set-phase --phase=code-review '.split(/\s+/);
  assert.deepEqual(dynamicSlot(t), { kind: 'models', index: t.length - 1 });
});

test('dynamicSlot: sessions and projects positions', () => {
  assert.deepEqual(dynamicSlot('/session resume '.split(/\s+/)), { kind: 'sessions', index: 2 });
  assert.deepEqual(dynamicSlot('/resume '.split(/\s+/)), { kind: 'sessions', index: 1 });
  assert.deepEqual(dynamicSlot('/session info '.split(/\s+/)), { kind: 'sessions', index: 2 });
  assert.deepEqual(dynamicSlot('/project drop '.split(/\s+/)), { kind: 'projects', index: 2 });
  assert.deepEqual(dynamicSlot('/project set current '.split(/\s+/)), { kind: 'projects', index: 3 });
  // alias
  assert.deepEqual(dynamicSlot('/project rm '.split(/\s+/)), { kind: 'projects', index: 2 });
});

test('dynamicContextKey: line → data kind (or null)', () => {
  assert.equal(dynamicContextKey('/model use '), 'models');
  assert.equal(dynamicContextKey('/session resume '), 'sessions');
  assert.equal(dynamicContextKey('/project drop '), 'projects');
  assert.equal(dynamicContextKey('/model list'), null);
  assert.equal(dynamicContextKey('hello'), null);
  assert.equal(dynamicContextKey(''), null);
});

/* -------------------------------------------------- rendering (dyn param) */

test('slashCompletions: model refs render with prefix filter and descriptions', () => {
  const dyn = { models: [
    { ref: 'openai/gpt-4o', desc: 'GPT-4o · openai · ctx 128000' },
    { ref: 'openai/gpt-4o-mini', desc: '' },
    { ref: 'deepseek/deepseek-v4-flash[1m]', desc: '' },
  ] };
  const all = slashCompletions('/model use ', dyn);
  assert.equal(all.items.length, 3);
  assert.ok(all.items.every(i => i.label.startsWith('/model use ')));
  assert.ok(all.items.some(i => i.label === '/model use deepseek/deepseek-v4-flash[1m]'));
  assert.equal(all.items.find(i => i.label === '/model use openai/gpt-4o').description, 'GPT-4o · openai · ctx 128000');

  const filtered = slashCompletions('/model use deep', dyn);
  assert.deepEqual(filtered.items.map(i => i.label), ['/model use deepseek/deepseek-v4-flash[1m]']);

  // Bare model-id fragments (no provider prefix) match the id after '/'.
  const byId = slashCompletions('/model use gpt-4o-m', dyn);
  assert.deepEqual(byId.items.map(i => i.label), ['/model use openai/gpt-4o-mini']);
  const byIdMulti = slashCompletions('/model use gp', dyn);
  assert.equal(byIdMulti.items.length, 2);
  // No match → nothing (never a full-list fallback in argument positions).
  assert.deepEqual(slashCompletions('/model use zz', dyn).items, []);

  // replaceFrom points at the fragment start, so accepting replaces ONLY
  // the typed partial (not the whole line).
  const part = slashCompletions('/model use op', dyn);
  assert.equal(part.replaceFrom, '/model use '.length);
});

test('slashCompletions: no dyn snapshot → legacy empty (no invention)', () => {
  for (const line of ['/model use ', '/session resume ', '/project drop ']) {
    const r = slashCompletions(line); // no dyn
    assert.deepEqual(r.items, [], line);
  }
});

test('slashCompletions: phase enum completes inline for set-phase', () => {
  const r = slashCompletions('/model set-phase --phase=');
  assert.deepEqual(
    r.items.map(i => i.label),
    [
      '/model set-phase --phase=rewrite-query',
      '/model set-phase --phase=request-assess',
      '/model set-phase --phase=plan-review',
      '/model set-phase --phase=code-review',
    ],
  );
  const one = slashCompletions('/model set-phase --phase=plan');
  assert.deepEqual(one.items.map(i => i.label), ['/model set-phase --phase=plan-review']);
});

test('slashCompletions: session and project items render', () => {
  const dyn = { sessions: [{ id: 'abc', desc: 'date · 1.0KB' }], projects: [{ ref: 'alpha', desc: '/w/alpha' }] };
  assert.deepEqual(slashCompletions('/session resume ', dyn).items.map(i => i.label), ['/session resume abc']);
  assert.deepEqual(slashCompletions('/resume ', dyn).items.map(i => i.label), ['/resume abc']);
  assert.deepEqual(slashCompletions('/project set current ', dyn).items.map(i => i.label), ['/project set current alpha']);
});

/* -------------------------------------------------- loaders (real stores) */

test('fetchDynamicItems(models): real models.json → refs sorted as stored', async () => {
  invalidateDynamicCache();
  const items = await fetchDynamicItems('models');
  const refs = items.map(i => i.ref);
  assert.ok(refs.includes('openai/gpt-4o'));
  assert.ok(refs.includes('openai/gpt-4o-mini'));
  assert.ok(refs.includes('deepseek/deepseek-v4-flash[1m]'));
  // The [1m] bracket suffix survives — the #1 hand-typing pitfall.
  assert.ok(items.find(i => i.ref === 'openai/gpt-4o').desc.includes('ctx 128000'));
});

test('fetchDynamicItems(sessions): newest first, id + size description', async () => {
  invalidateDynamicCache();
  const items = await fetchDynamicItems('sessions', { projectId: 'proj-alpha-1' });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'newer'); // sorted by mtime desc
  assert.equal(items[1].id, 'older');
  assert.ok(items[0].desc.includes('KB'));
});

test('fetchDynamicItems(sessions): missing project / empty dir → []', async () => {
  invalidateDynamicCache();
  assert.deepEqual(await fetchDynamicItems('sessions'), []);
  assert.deepEqual(await fetchDynamicItems('sessions', { projectId: 'no-such' }), []);
});

test('fetchDynamicItems(projects): token-safe name preferred, id fallback', async () => {
  invalidateDynamicCache();
  const items = await fetchDynamicItems('projects');
  // 'alpha' has no spaces → name; 'beta project' has → falls back to id.
  assert.ok(items.some(i => i.ref === 'alpha' && i.desc === '/w/alpha'));
  assert.ok(items.some(i => i.ref === 'proj-beta-2'));
});

test('fetchDynamicItems: unknown kind → [] (never throws)', async () => {
  assert.deepEqual(await fetchDynamicItems('nope'), []);
});

test('fetchDynamicItems: TTL cache — second call is served without re-reading', async () => {
  invalidateDynamicCache();
  await fetchDynamicItems('models');
  const snap = currentDynamicSnapshot();
  assert.ok(Array.isArray(snap.models) && snap.models.length === 3, 'snapshot exposes cached models');
  // Corrupt the store behind the cache's back; the cached copy must survive.
  await saveModels({ default: null, providers: {} });
  const again = await fetchDynamicItems('models');
  assert.equal(again.length, 3, 'served from cache');
  // Invalidation forces a re-read → now empty.
  invalidateDynamicCache('models');
  assert.equal((await fetchDynamicItems('models')).length, 0);
});

test('TUI completionMenu: dyn flows through to the rendered menu', async () => {
  const { completionMenu } = await import('../src/tui/completion.js');
  // Re-seed: the TTL test above deliberately left the models cache EMPTY,
  // and its entries are still within TTL — rebuild the store + invalidate.
  await saveModels({
    default: 'openai/gpt-4o',
    providers: {
      openai: { api: 'openai', apiKey: 'k', baseUrl: 'https://x/v1', models: [
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
        { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000 },
      ] },
      deepseek: { api: 'openai', apiKey: 'k', baseUrl: 'https://y/v1', models: [{ id: 'deepseek-v4-flash[1m]', contextWindow: 128000 }] },
    },
  });
  invalidateDynamicCache();
  await fetchDynamicItems('models');
  const snap = currentDynamicSnapshot();
  const m = completionMenu('/model use ', { dyn: snap, width: 100 });
  assert.ok(m.open);
  assert.ok(m.items.length === 3);
  assert.ok(m.lines.length > 0);
  // Legacy call shape (no dyn) still renders nothing for argument positions.
  const legacy = completionMenu('/model use ', { width: 100 });
  assert.equal(legacy.open, false);
});

test('REPL completer shape: dynamic hit replaces the candidate list', async () => {
  // Same wiring makeCompleter uses: fetch then render with a single-kind snapshot.
  invalidateDynamicCache();
  const items = await fetchDynamicItems('sessions', { projectId: 'proj-alpha-1' });
  const r = slashCompletions('/session resume ', { sessions: items });
  assert.deepEqual(r.items.map(i => i.label), ['/session resume newer', '/session resume older']);
});
