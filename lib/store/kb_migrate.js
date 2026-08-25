/*-------------------------------------------------------------------------
 *
 * kb_migrate.js — legacy-KB detection & lossless upgrade for /kb update.
 *
 * A KB built by an older hk2 can lag the current code in several ways:
 *   1. principles/ directory        (pre-Holy/Eden layout)
 *   2. meta.parserVersion < current (symbol shards parsed by an older parser)
 *   3. includeGlobs frozen at the legacy 40-glob default (no doc formats)
 *   4. missing hk2-supreme-code entry (feature shipped after the KB)
 *   5. missing/empty doc_index.json _docInputs (pre doc-graph, or poisoned)
 *   6. meta.version < KB_LAYOUT_VERSION (catch-all forward signal)
 *
 * detectKbUpgrade() lists what is stale; migrateKb() performs a lossless
 * upgrade: irreplaceable knowledge (holy/ eden/ principles/) is snapshotted
 * to backup/pre-upgrade-<ts>/ BEFORE anything is touched, then each item is
 * fixed. Derived artifacts (symbols/, inverted.json, graph/) are rebuilt by
 * buildIndex and are not backed up.
 *
 * Callers: the three /kb update entrypoints (slash /kb update, CLI
 * --mode=update-kb, interactive auto-refresh) all run migrateKb() first.
 * When nothing is stale it is a no-op returning { needed: false }.
 *
 * Copyright (c) 2026 hk2 contributors.
 *----------------------------------------------------------------------*/

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getMeta, saveMeta, kbDir, holyDir, edenDir,
  migrateLegacyPrinciples, KB_LAYOUT_VERSION,
} from './kb_store.js';
import { readDocIndex } from './doc_index_store.js';
import { ensureSupremeCode, SUPREME_CODE_ID } from './supreme_code.js';
import { readKnowledge } from './kb_store.js';
import { DEFAULT_INCLUDE_GLOBS } from '../config/home.js';

export { KB_LAYOUT_VERSION };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Snapshot of the pre-doc-parse default include list (40 globs, no
 * sgml/pdf/office formats). Must stay byte-identical to the historical
 * default so legacy KBs are detected by exact match; custom globs never
 * match and are therefore never touched.
 */
export const LEGACY_DEFAULT_INCLUDE_40 = [
  '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.cxx',
  '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.scala',
  '**/*.rb', '**/*.php', '**/*.swift',
  '**/*.sh', '**/*.bash', '**/*.zsh',
  '**/*.y', '**/*.l',
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.html', '**/*.htm',
];

const sameList = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((g, i) => g === b[i]);

/* ------------------------------------------------------------------ */
/* Detection                                                            */
/* ------------------------------------------------------------------ */

async function dirExists(p) {
  try { const st = await fs.stat(p); return st.isDirectory(); } catch { return false; }
}
async function fileExists(p) {
  try { const st = await fs.stat(p); return st.isFile(); } catch { return false; }
}

/**
 * Detect every stale signal on one KB.
 * @returns {Promise<{items: Array<{id, reason, detail?}>}>}
 *   items is empty when the KB is already current.
 */
export async function detectKbUpgrade(name) {
  const items = [];
  const dir = kbDir(name);

  if (await dirExists(path.join(dir, 'principles'))) {
    items.push({ id: 'legacy-principles', reason: 'principles/ directory exists (pre-Holy/Eden layout)' });
  }

  const meta = await getMeta(name).catch(() => null);
  if (meta) {
    if (Number.isFinite(meta.parserVersion)) {
      const { PARSER_VERSION } = await import('../index/registry.js');
      if (meta.parserVersion < PARSER_VERSION) {
        items.push({
          id: 'parser-version',
          reason: `parserVersion ${meta.parserVersion} < ${PARSER_VERSION} (symbol shards produced by an older parser)`,
          detail: { from: meta.parserVersion, to: PARSER_VERSION },
        });
      }
    }
    if (sameList(meta.includeGlobs, LEGACY_DEFAULT_INCLUDE_40)) {
      items.push({
        id: 'legacy-include-globs',
        reason: 'includeGlobs is the legacy 40-entry default list (missing sgml/pdf/office document formats)',
      });
    }
    if (!Number.isFinite(meta.version) || meta.version < KB_LAYOUT_VERSION) {
      items.push({
        id: 'kb-layout-version',
        reason: `meta.version ${meta.version ?? '(missing)'} < ${KB_LAYOUT_VERSION}`,
        detail: { from: meta.version ?? null, to: KB_LAYOUT_VERSION },
      });
    }
  }

  const supreme = await readKnowledge(name, 'holy', SUPREME_CODE_ID).catch(() => null);
  if (!supreme) {
    items.push({ id: 'supreme-code-missing', reason: 'hk2-supreme-code entry is missing' });
  }

  const docIdx = await readDocIndex(name).catch(() => null);
  const docInputsUsable = !!(docIdx && Array.isArray(docIdx._docInputs) && docIdx._docInputs.length > 0);
  // Only an upgrade signal when the KB actually HAS docs to migrate; a KB
  // with zero documents legitimately has an empty (or missing) doc index.
  const hasDocs = docIdx ? (docIdx.meta?.docCount || 0) > 0 || Object.keys(docIdx.docs || {}).length > 0 : false;
  if (!docInputsUsable && (hasDocs || fileExists(path.join(dir, 'doc_index.json')))) {
    items.push({
      id: 'doc-graph-empty',
      reason: 'doc_index.json missing or _docInputs empty (doc reference graph cannot be merged incrementally)',
    });
  }

  return { items };
}

/* ------------------------------------------------------------------ */
/* Lossless backup                                                      */
/* ------------------------------------------------------------------ */

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) await copyDir(from, to);
    else await fs.copyFile(from, to);
  }
}

/**
 * Snapshot the irreplaceable knowledge spaces (holy/ eden/ principles/) to
 * backup/pre-upgrade-<ts>/. Derived artifacts are excluded — buildIndex
 * rebuilds them. Best-effort: a backup failure ABORTS the migration (never
 * upgrade without the safety net), returning { ok: false, error }.
 */
async function backupKnowledge(name, tag) {
  const dir = kbDir(name);
  const backupDir = path.join(dir, 'backup', `pre-upgrade-${tag}`);
  const backed = [];
  for (const sub of ['holy', 'eden', 'principles']) {
    const src = path.join(dir, sub);
    if (!(await dirExists(src))) continue;
    await copyDir(src, path.join(backupDir, sub));
    backed.push(sub);
  }
  // meta.json is tiny and tells us exactly what we upgraded from.
  if (await fileExists(path.join(dir, 'meta.json'))) {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(path.join(dir, 'meta.json'), path.join(backupDir, 'meta.json'));
  }
  return { backupDir, backed };
}

/* ------------------------------------------------------------------ */
/* Migration                                                            */
/* ------------------------------------------------------------------ */

/**
 * Upgrade a legacy KB to the current layout, losslessly.
 *
 * @param {string} name KB name (= project id)
 * @param {{dryRun?: boolean, backup?: boolean}} [opts]
 * @returns {Promise<{needed: boolean, items?: Array, backupDir?: string|null,
 *                     performed?: string[], fullRebuild?: boolean, error?: string}>}
 *   fullRebuild=true tells the caller to run buildIndex({full:true}) — the
 *   stale parser-version symbol shards must be re-parsed, not incrementally
 *   patched.
 */
export async function migrateKb(name, opts = {}) {
  const detect = await detectKbUpgrade(name);
  if (detect.items.length === 0) return { needed: false };

  if (opts.dryRun) {
    return { needed: true, items: detect.items, dryRun: true };
  }

  const performed = [];
  let fullRebuild = false;
  const ids = new Set(detect.items.map(i => i.id));

  // 1) Lossless snapshot FIRST (skip only when the caller explicitly opts out,
  //    e.g. tests that construct throwaway KBs).
  let backupDir = null;
  if (opts.backup !== false) {
    try {
      const tag = new Date().toISOString().replace(/[:.]/g, '-');
      const b = await backupKnowledge(name, tag);
      backupDir = b.backupDir;
      performed.push(`backup: ${b.backed.length ? b.backed.join('+') : '(nothing to back up)'} -> ${path.relative(kbDir(name), backupDir)}`);
    } catch (err) {
      return { needed: true, items: detect.items, error: `backup failed, migration aborted: ${err.message}` };
    }
  }

  // 2) principles/ → holy/  (idempotent; skips files already migrated)
  if (ids.has('legacy-principles')) {
    const moved = await migrateLegacyPrinciples(name);
    performed.push(`principles -> holy: ${moved} entr${moved === 1 ? 'y' : 'ies'} migrated`);
  }

  // 3) includeGlobs upgrade + parserVersion/version bump
  const meta = await getMeta(name).catch(() => null);
  if (meta) {
    const { PARSER_VERSION } = await import('../index/registry.js');
    const patch = {};
    if (ids.has('legacy-include-globs')) {
      patch.includeGlobs = DEFAULT_INCLUDE_GLOBS;
    }
    if (meta.parserVersion < PARSER_VERSION) {
      patch.parserVersion = PARSER_VERSION;
      fullRebuild = true;   // old-format symbol shards need a full re-parse
    }
    if (!Number.isFinite(meta.version) || meta.version < KB_LAYOUT_VERSION) {
      patch.version = KB_LAYOUT_VERSION;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date().toISOString();
      await saveMeta(name, { ...meta, ...patch });
      performed.push(`meta: ${Object.keys(patch).filter(k => k !== 'updatedAt').join(', ') || '(refreshed)'} updated`);
    }
  }

  // 4) supreme-code backfill (additive only, never overwrites)
  if (ids.has('supreme-code-missing')) {
    const { created } = await ensureSupremeCode(name, { createdVia: 'kb-update-upgrade' });
    performed.push(`supreme-code: ${created ? 'created (empty)' : 'already present'}`);
  }

  // 5) doc graph: the indexer's incremental run rebuilds it; when the KB has
  //    docs but no usable _docInputs the indexer force re-parses them
  //    (skippedTrackedDocs rescue, added with the doc-graph feature).
  if (ids.has('doc-graph-empty')) {
    performed.push('doc-graph: will be rebuilt by the following incremental index (force re-parse of unchanged docs)');
  }

  return { needed: true, items: detect.items, backupDir, performed, fullRebuild };
}
