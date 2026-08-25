/*-------------------------------------------------------------------------
 *
 * Regression tests for the /kb update legacy-KB upgrade:
 *   - detectKbUpgrade recognizes every stale signal (and no false positives
 *     on a current KB)
 *   - migrateKb upgrades losslessly: every knowledge entry survives
 *     byte-for-byte, includeGlobs/meta versions are bumped, backup snapshot
 *     is taken, dry-run touches nothing
 *   - the three /kb update entrypoints trigger the upgrade (spot-checked via
 *     the shared migrateKb call they all make)
 *
 * Run:  node --test test/kb_migrate.test.js
 *
 * Copyright (c) 2026 hk2 contributors.
 *----------------------------------------------------------------------*/

// MUST be the first import: isolates HK2_HOME so the project store + KB root
// are per-test-run temp dirs.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import * as home from '../lib/config/home.js';
import { addKbForProject, PARSER_VERSION } from '../lib/index/registry.js';
import { buildIndex } from '../lib/index/indexer.js';
import { listKnowledge } from '../lib/store/kb_store.js';
import {
  detectKbUpgrade, migrateKb, KB_LAYOUT_VERSION, LEGACY_DEFAULT_INCLUDE_40,
} from '../lib/store/kb_migrate.js';

const HK2_HOME = () => process.env.HK2_HOME;
const kbDirOf = (id) => path.join(HK2_HOME(), 'kb', id);

async function writeJson(fp, obj) {
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(obj, null, 2));
}

/** Build a tiny project + CURRENT-layout KB, then optionally regress it. */
async function makeKb({ regress = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-migrate-'));
  await fs.writeFile(path.join(dir, 'a.js'), 'export function alpha() { return 1; }\n');
  await fs.writeFile(path.join(dir, 'README.md'), '# T\n\nSee [g](docs/g.md).\n\n| P | V |\n|---|---|\n| port | 1 |\n');
  await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs', 'g.md'), '# G\n\nalpha()\n');

  const p = await home.registerProject({ sourcePath: dir, name: 'migrate-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) });
  await home.setCurrentProject(p.id);
  await addKbForProject(p);
  await buildIndex(p.id, { skipSummary: true });

  const kb = kbDirOf(p.id);
  for (const r of regress) {
    if (r === 'principles') {
      // Legacy pre-Holy/Eden layout: knowledge lived in principles/<topic>.json
      await writeJson(path.join(kb, 'principles', 'legacy-rule.json'),
        { topic: 'legacy-rule', title: 'Legacy Rule', intro: 'old space layout', keyFiles: [], keywords: [] });
    }
    if (r === 'parser-version') {
      const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
      meta.parserVersion = 1;
      await fs.writeFile(path.join(kb, 'meta.json'), JSON.stringify(meta));
    }
    if (r === 'legacy-globs') {
      const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
      meta.includeGlobs = [...LEGACY_DEFAULT_INCLUDE_40];
      await fs.writeFile(path.join(kb, 'meta.json'), JSON.stringify(meta));
    }
    if (r === 'version-1') {
      const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
      meta.version = 1;
      await fs.writeFile(path.join(kb, 'meta.json'), JSON.stringify(meta));
    }
    if (r === 'no-version') {
      // Oldest KBs predate meta.version entirely — the field is ABSENT.
      const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
      delete meta.version;
      await fs.writeFile(path.join(kb, 'meta.json'), JSON.stringify(meta));
    }
    if (r === 'no-supreme-code') {
      await fs.rm(path.join(kb, 'holy', 'hk2-supreme-code.json'), { force: true });
    }
    if (r === 'no-doc-index') {
      await fs.rm(path.join(kb, 'doc_index.json'), { force: true });
    }
    if (r === 'custom-globs') {
      const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
      meta.includeGlobs = ['**/*.js'];
      await fs.writeFile(path.join(kb, 'meta.json'), JSON.stringify(meta));
    }
  }
  return { dir, p, kb };
}

async function knowledgeSnapshot(id) {
  const out = {};
  for (const space of ['holy', 'eden']) {
    out[space] = {};
    for (const e of await listKnowledge(id, space)) {
      // Sort entry-level arrays so order changes don't create false diffs.
      const clone = JSON.parse(JSON.stringify(e));
      for (const k of Object.keys(clone)) {
        if (Array.isArray(clone[k])) clone[k] = [...clone[k]].sort();
      }
      out[space][e.id] = clone;
    }
  }
  return out;
}

/* --------------------------- detection --------------------------------- */

test('detectKbUpgrade: current KB yields no items', async () => {
  const { dir, p } = await makeKb();
  try {
    const r = await detectKbUpgrade(p.id);
    assert.deepEqual(r.items.map(i => i.id), [], `expected no signals, got ${JSON.stringify(r.items)}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('detectKbUpgrade: recognizes every legacy signal individually', async () => {
  const cases = [
    ['principles', 'legacy-principles'],
    ['parser-version', 'parser-version'],
    ['legacy-globs', 'legacy-include-globs'],
    ['version-1', 'kb-layout-version'],
    ['no-version', 'kb-layout-version'],
    ['no-supreme-code', 'supreme-code-missing'],
  ];
  for (const [regress, expectId] of cases) {
    const { dir, p } = await makeKb({ regress: [regress] });
    try {
      const r = await detectKbUpgrade(p.id);
      assert.ok(r.items.some(i => i.id === expectId),
        `${regress} should surface ${expectId}, got ${JSON.stringify(r.items.map(i => i.id))}`);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('detectKbUpgrade: doc-graph signal only fires when a doc index SHOULD exist', async () => {
  // A KB with real docs, doc_index.json deleted → signal fires.
  const { dir, p } = await makeKb({ regress: ['no-doc-index'] });
  try {
    const r = await detectKbUpgrade(p.id);
    assert.ok(r.items.some(i => i.id === 'doc-graph-empty'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('detectKbUpgrade: custom includeGlobs are NOT flagged as legacy', async () => {
  const { dir, p } = await makeKb({ regress: ['custom-globs'] });
  try {
    const r = await detectKbUpgrade(p.id);
    assert.ok(!r.items.some(i => i.id === 'legacy-include-globs'),
      'custom globs must never match the legacy default');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

/* --------------------------- migration --------------------------------- */

test('migrateKb: no-op when the KB is current', async () => {
  const { dir, p } = await makeKb();
  try {
    const r = await migrateKb(p.id);
    assert.equal(r.needed, false);
    assert.equal(r.performed, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('migrateKb: dry-run reports but touches nothing', async () => {
  const { dir, p, kb } = await makeKb({ regress: ['legacy-globs', 'no-supreme-code'] });
  try {
    const before = await knowledgeSnapshot(p.id);
    const metaBefore = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));

    const r = await migrateKb(p.id, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.ok(r.items.length >= 2, 'dry-run lists the signals');

    assert.deepEqual(await knowledgeSnapshot(p.id), before, 'knowledge untouched by dry-run');
    const metaAfter = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
    assert.deepEqual(metaAfter, metaBefore, 'meta untouched by dry-run');
    assert.equal(await fs.stat(path.join(kb, 'backup')).catch(() => null), null, 'no backup on dry-run');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('migrateKb: full legacy KB upgrades losslessly (knowledge byte-identical, globs/version bumped, backup taken)', async () => {
  const { dir, p, kb } = await makeKb({
    regress: ['principles', 'parser-version', 'legacy-globs', 'version-1', 'no-supreme-code'],
  });
  try {
    // Pre-migration snapshot of every knowledge entry that must survive.
    // legacy-rule comes from principles/ (not listed by listKnowledge yet).
    const legacyRule = JSON.parse(await fs.readFile(path.join(kb, 'principles', 'legacy-rule.json'), 'utf8'));
    const before = await knowledgeSnapshot(p.id);
    const edenCount = Object.keys(before.eden).length;
    assert.ok(edenCount > 0, 'fixture must own eden entries (doc:) to prove they survive');

    const r = await migrateKb(p.id);
    assert.equal(r.needed, true);
    assert.ok(!r.error, `migration must not error: ${r.error}`);
    assert.equal(r.fullRebuild, true, 'parser-version regression forces full rebuild');

    // 1) Knowledge losslessness: every pre-existing entry survives unchanged.
    const after = await knowledgeSnapshot(p.id);
    for (const [space, entries] of Object.entries(before)) {
      for (const [id, entry] of Object.entries(entries)) {
        assert.deepEqual(after[space][id], entry, `${space}:${id} must survive byte-identically`);
      }
    }
    // 2) principles/ migrated into holy/ with id preserved.
    const migrated = after.holy['legacy-rule'];
    assert.ok(migrated, 'legacy-rule present in holy after migration');
    assert.equal(migrated.title, legacyRule.title);
    assert.equal(migrated.intro, legacyRule.intro);
    assert.equal(await fs.stat(path.join(kb, 'principles')).catch(() => null), null, 'principles/ removed');
    // 3) meta upgraded.
    const meta = JSON.parse(await fs.readFile(path.join(kb, 'meta.json'), 'utf8'));
    assert.equal(meta.parserVersion, PARSER_VERSION);
    assert.equal(meta.version, KB_LAYOUT_VERSION);
    assert.ok(meta.includeGlobs.includes('**/*.pdf'), 'includeGlobs upgraded to current default');
    assert.equal(meta.includeGlobs.length, (await import('../lib/config/home.js')).DEFAULT_INCLUDE_GLOBS.length);
    // 4) supreme-code backfilled.
    assert.ok(after.holy['hk2-supreme-code'], 'supreme-code created');
    // 5) Backup snapshot exists and holds the pre-upgrade knowledge.
    const backups = await fs.readdir(path.join(kb, 'backup'));
    assert.equal(backups.length, 1, 'exactly one pre-upgrade backup');
    const bdir = path.join(kb, 'backup', backups[0]);
    assert.ok(await fs.stat(path.join(bdir, 'meta.json')).catch(() => null), 'backup holds meta.json');
    assert.ok(await fs.stat(path.join(bdir, 'principles', 'legacy-rule.json')).catch(() => null), 'backup holds pre-migration principles/');
    for (const id of Object.keys(before.eden)) {
      const fp = id.replace(/[^A-Za-z0-9_.-]/g, '_') + '.json';
      assert.ok(await fs.stat(path.join(bdir, 'eden', fp)).catch(() => null), `backup holds eden/${fp}`);
    }
    // 6) Second run is a no-op (idempotent).
    const r2 = await migrateKb(p.id);
    assert.equal(r2.needed, false, `idempotent, got ${JSON.stringify(r2.items?.map(i => i.id))}`);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('migrateKb: full rebuild after upgrade parses docs into the doc graph (end-to-end /kb update flow)', async () => {
  const { dir, p, kb } = await makeKb({ regress: ['parser-version', 'no-doc-index'] });
  try {
    const before = await knowledgeSnapshot(p.id);
    const migration = await migrateKb(p.id);
    assert.equal(migration.fullRebuild, true);

    // Simulate what all three /kb update entrypoints now do.
    const stats = await buildIndex(p.id, { full: migration.fullRebuild, skipSummary: true });
    assert.ok(stats.totalDocs >= 2, `docs re-parsed, got ${stats.totalDocs}`);

    const after = await knowledgeSnapshot(p.id);
    for (const [space, entries] of Object.entries(before)) {
      for (const id of Object.keys(entries)) {
        assert.ok(after[space][id], `${space}:${id} survives the upgraded full rebuild`);
      }
    }
    const docIdx = JSON.parse(await fs.readFile(path.join(kb, 'doc_index.json'), 'utf8'));
    assert.ok(docIdx._docInputs.length >= 2, 'doc graph rebuilt with usable _docInputs');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
