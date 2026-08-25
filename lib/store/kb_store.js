/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * KB storage path management. All KB data lives under ~/.hk2/kb/<projectId>/.
 *
 * Three-space layout:
 *   holy/      — Holy Space: stable knowledge (design principles, key algorithms).
 *                Updates always require explicit user approval, regardless of
 *                HK2_ENABLE_AUTOUPDATEKB / HK2_ENABLE_AUTO_LEARN.
 *   eden/      — Eden Space: frequently-updated knowledge (function lists,
 *                SQL command catalogs, etc.). Auto-updatable.
 *   <root>     — Index Space: code index (files.json, inverted.json,
 *                callgraph.json, symbols.*.json, stats.json) plus
 *                holy.idx.json / eden.idx.json — BM25 indexes over the
 *                knowledge entries in each space.
 *
 * History: v1 stored data under <hk2cli>/.kb/<name>/; v2 moved to ~/.hk2/kb/.
 * The "principles/" directory (now "holy/") is auto-migrated on first load.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeJsonAtomic, readJsonSafe, exists, rmrf } from '../util/fs_atomic.js';
import { shortHash } from '../util/hash.js';
import { KB_ROOT as HOME_KB_ROOT } from '../config/home.js';
import { SUPREME_CODE_ID } from './supreme_code.js';

export const KB_ROOT = path.resolve(process.env.HK2_KB_DIR || HOME_KB_ROOT);

/* Spaces */
export const SPACES = ['holy', 'eden'];

/**
 * KB layout version — the on-disk layout contract this hk2 build writes.
 * Bump when a structural change needs an upgrade path (see
 * lib/store/kb_migrate.js). New KBs are born at the current version; older
 * KBs are detected via meta.version < KB_LAYOUT_VERSION on /kb update.
 */
export const KB_LAYOUT_VERSION = 2;

export function kbDir(name) { return path.join(KB_ROOT, name); }
export function metaPath(name) { return path.join(kbDir(name), 'meta.json'); }

/* --- Index Space (code index + per-space knowledge indexes) --- */
export function filesPath(name) { return path.join(kbDir(name), 'files.json'); }
export function symbolsPath(name, fileId) {
  const shardNum = Math.floor(fileId / 256);
  const shardHex = String(shardNum).padStart(4, '0');
  return path.join(kbDir(name), `symbols.${shardHex}.json`);
}
export function invertedPath(name) { return path.join(kbDir(name), 'inverted.json'); }
export function callgraphPath(name) { return path.join(kbDir(name), 'callgraph.json'); }
export function statsPath(name) { return path.join(kbDir(name), 'stats.json'); }
export function holyIndexPath(name) { return path.join(kbDir(name), 'holy.idx.json'); }
export function edenIndexPath(name) { return path.join(kbDir(name), 'eden.idx.json'); }
export function summariesDir(name) { return path.join(kbDir(name), 'summaries'); }
export function summaryPath(name, symbolId) {
  const safe = String(symbolId).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(summariesDir(name), `${safe}.md`);
}

/* --- Holy / Eden knowledge directories --- */
export function holyDir(name) { return path.join(kbDir(name), 'holy'); }
export function edenDir(name) { return path.join(kbDir(name), 'eden'); }
/** Look up the directory for a given space name. */
export function knowledgeDir(name, space) {
  if (space === 'holy') return holyDir(name);
  if (space === 'eden') return edenDir(name);
  throw new Error(`unknown space: ${space}`);
}

/** @deprecated alias for backward compatibility (holy). Old principle code paths. */
export function principlesDir(name) { return holyDir(name); }

export async function listKbs() {
  if (!await exists(KB_ROOT)) return [];
  const entries = await fs.readdir(KB_ROOT, { withFileTypes: true });
  const result = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = await readJsonSafe(metaPath(ent.name), null);
    if (meta) result.push(meta);
  }
  return result;
}

export async function getMeta(name) {
  return readJsonSafe(metaPath(name), null);
}

export async function saveMeta(name, meta) {
  await writeJsonAtomic(metaPath(name), meta);
}

export async function createKbDir(name) {
  await fs.mkdir(kbDir(name), { recursive: true });
  await fs.mkdir(holyDir(name), { recursive: true });
  await fs.mkdir(edenDir(name), { recursive: true });
  await fs.mkdir(summariesDir(name), { recursive: true });
  // Auto-migrate legacy principles/ → holy/
  await migrateLegacyPrinciples(name);
}

export async function deleteKb(name) {
  await rmrf(kbDir(name));
}

/* --- File-level sharded symbol store (Index Space) --- */
export async function readFiles(name) {
  return readJsonSafe(filesPath(name), { byId: {}, byPath: {}, nextId: 1 });
}
export async function writeFiles(name, data) {
  await writeJsonAtomic(filesPath(name), data);
}
export async function readStats(name) {
  return readJsonSafe(statsPath(name), null);
}
export async function writeStats(name, stats) {
  await writeJsonAtomic(statsPath(name), stats);
}
export async function readInverted(name) {
  return readJsonSafe(invertedPath(name), null);
}
export async function writeInverted(name, data) {
  await writeJsonAtomic(invertedPath(name), data);
}
export async function readCallgraph(name) {
  return readJsonSafe(callgraphPath(name), {});
}
export async function writeCallgraph(name, data) {
  await writeJsonAtomic(callgraphPath(name), data);
}
export async function readSymbolsShard(name, shardNum) {
  const shardHex = String(shardNum).padStart(4, '0');
  const p = path.join(kbDir(name), `symbols.${shardHex}.json`);
  return readJsonSafe(p, { symbols: [] });
}
export async function writeSymbolsShard(name, shardNum, data) {
  const shardHex = String(shardNum).padStart(4, '0');
  const p = path.join(kbDir(name), `symbols.${shardHex}.json`);
  await writeJsonAtomic(p, data);
}
export async function listSymbolShards(name) {
  if (!await exists(kbDir(name))) return [];
  const entries = await fs.readdir(kbDir(name));
  const shards = [];
  for (const ent of entries) {
    const m = /^symbols\.([0-9a-fA-F]{4})\.json$/.exec(ent);
    if (m) shards.push({ shardNum: parseInt(m[1], 16), path: path.join(kbDir(name), ent) });
  }
  return shards;
}
export async function* iterAllSymbols(name) {
  const shards = await listSymbolShards(name);
  for (const s of shards) {
    const data = await readJsonSafe(s.path, { symbols: [] });
    for (const sym of data.symbols || []) yield sym;
  }
}
export async function loadSymbolById(name, symbolId) {
  const m = /^(\d+):/.exec(symbolId);
  if (!m) return null;
  const fileId = parseInt(m[1], 10);
  const shard = await readSymbolsShard(name, Math.floor(fileId / 256));
  return (shard.symbols || []).find(s => s.id === symbolId) || null;
}

/* --- Knowledge entries (Holy / Eden Spaces) --- */

/**
 * List knowledge entries in a space. Returns array of {id, space, title, intro, ...}.
 */
export async function listKnowledge(name, space) {
  const dir = knowledgeDir(name, space);
  if (!await exists(dir)) return [];
  const entries = await fs.readdir(dir);
  const result = [];
  for (const ent of entries) {
    if (!ent.endsWith('.json')) continue;
    const data = await readJsonSafe(path.join(dir, ent), null);
    if (data) {
      // Ensure required fields
      if (!data.id) data.id = ent.replace(/\.json$/, '');
      if (!data.space) data.space = space;
      result.push(data);
    }
  }
  return result;
}

export async function readKnowledge(name, space, id) {
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
  return readJsonSafe(path.join(knowledgeDir(name, space), `${safe}.json`), null);
}

/**
 * Find a knowledge entry by id, searching both spaces. Returns {entry, space}
 * or null. Useful when the caller doesn't know which space an entry lives in.
 */
export async function findKnowledge(name, id) {
  for (const space of SPACES) {
    const ent = await readKnowledge(name, space, id);
    if (ent) return { entry: ent, space };
  }
  return null;
}

/**
 * Atomically write a knowledge entry to a space. The entry's `id` and `space`
 * fields are normalized. Returns the absolute path written.
 */
export async function writeKnowledge(name, space, entry) {
  if (!SPACES.includes(space)) throw new Error(`unknown space: ${space}`);
  await fs.mkdir(knowledgeDir(name, space), { recursive: true });
  const id = String(entry.id || 'untitled').replace(/[^A-Za-z0-9_.-]/g, '_');
  const record = {
    ...entry,
    id: entry.id || id,
    space,
    updatedAt: new Date().toISOString(),
    createdAt: entry.createdAt || new Date().toISOString(),
  };
  if (!record.spaceChangedAt) record.spaceChangedAt = record.createdAt;
  const p = path.join(knowledgeDir(name, space), `${id}.json`);
  await writeJsonAtomic(p, record);
  return p;
}

/**
 * Move a knowledge entry from one space to another. Used by /kb transform.
 * Returns the new path, or null if the entry wasn't found in the source space.
 * The permanent supreme-code entry can never be moved.
 */
export async function moveKnowledge(name, id, fromSpace, toSpace) {
  if (!SPACES.includes(fromSpace)) throw new Error(`unknown source space: ${fromSpace}`);
  if (!SPACES.includes(toSpace)) throw new Error(`unknown target space: ${toSpace}`);
  if (fromSpace === toSpace) throw new Error('source and target space are the same');
  if (id === SUPREME_CODE_ID) throw new Error(`entry "${SUPREME_CODE_ID}" is permanent and cannot be moved`);
  const entry = await readKnowledge(name, fromSpace, id);
  if (!entry) return null;
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
  // Write to target, then delete from source
  const target = await writeKnowledge(name, toSpace, { ...entry, spaceChangedAt: new Date().toISOString() });
  await fs.unlink(path.join(knowledgeDir(name, fromSpace), `${safe}.json`));
  return target;
}

export async function deleteKnowledge(name, space, id) {
  if (id === SUPREME_CODE_ID) throw new Error(`entry "${SUPREME_CODE_ID}" is permanent and cannot be deleted (manage items via /kb code del)`);
  const safe = String(id).replace(/[^A-Za-z0-9_.-]/g, '_');
  const p = path.join(knowledgeDir(name, space), `${safe}.json`);
  if (!await exists(p)) return false;
  await fs.unlink(p);
  return true;
}

/* --- Index Space: per-space BM25 indexes --- */

export async function readKnowledgeIndex(name, space) {
  const p = space === 'holy' ? holyIndexPath(name) : edenIndexPath(name);
  return readJsonSafe(p, null);
}
export async function writeKnowledgeIndex(name, space, data) {
  const p = space === 'holy' ? holyIndexPath(name) : edenIndexPath(name);
  await writeJsonAtomic(p, data);
}

/**
 * Rebuild the per-space BM25 knowledge index (holy.idx.json / eden.idx.json)
 * from the on-disk knowledge entries. One document per entry (docId = entry
 * id; tokens = title + keywords + intro, tokenized by the shared text
 * tokenizer). This is the canonical way to bring the knowledge indexes back
 * in sync after any bulk mutation (housekeep merge/delete, transform, ...).
 *
 * Superseded Eden entries (supersededBy set) are indexed anyway — retirement
 * from retrieval is a runtime concern (graph.js filters them), not an index
 * concern; keeping them indexed preserves the ability to re-activate.
 *
 * @param {string} name project id
 * @param {string} space 'holy' | 'eden'
 * @returns {Promise<{count:number, path:string}>} entries indexed + file written
 */
export async function rebuildKnowledgeIndex(name, space) {
  if (!SPACES.includes(space)) throw new Error(`unknown space: ${space}`);
  const { BM25Index } = await import('../index/bm25.js');
  const { tokenizeText } = await import('../index/text_tokenizer.js');
  const entries = await listKnowledge(name, space);
  const idx = new BM25Index();
  for (const e of entries) {
    if (!e || !e.id) continue;
    const text = [e.title || '', (e.keywords || []).join(' '), e.intro || ''].join('\n');
    idx.addDoc(e.id, tokenizeText(text));
  }
  idx.finalize();
  const p = space === 'holy' ? holyIndexPath(name) : edenIndexPath(name);
  await writeJsonAtomic(p, {
    space,
    builtAt: new Date().toISOString(),
    entryCount: entries.length,
    index: idx.serialize(),
  });
  return { count: entries.length, path: p };
}

/* --- Summaries (per-symbol notes; legacy) --- */
export async function readSummary(name, symbolId) {
  const p = summaryPath(name, symbolId);
  if (!await exists(p)) return null;
  return fs.readFile(p, 'utf8');
}
export async function writeSummary(name, symbolId, text) {
  await fs.mkdir(summariesDir(name), { recursive: true });
  const p = summaryPath(name, symbolId);
  await writeJsonAtomic(p.replace(/\.md$/, '.meta.json'), { symbolId, generatedAt: new Date().toISOString() });
  await fs.writeFile(p, text, 'utf8');
}
export async function readSummaryMeta(name, symbolId) {
  const p = summaryPath(name, symbolId).replace(/\.md$/, '.meta.json');
  return readJsonSafe(p, null);
}

/* --- Migration --- */

/**
 * If a legacy `principles/` directory exists (from a previous hk2 version),
 * move all its .json entries into `holy/`. Idempotent — no-op if no legacy
 * dir. Runs at createKbDir time and at KB runtime load time.
 *
 * The entry's id is derived from its filename (e.g. `cache.json` → id `cache`).
 * If the entry already has an `id` field that differs from the filename, we
 * rename the file to match the id during migration so future reads are
 * consistent. Old `topic` field (the legacy identifier) is preserved as
 * `legacyTopic` for traceability.
 */
export async function migrateLegacyPrinciples(name) {
  const legacy = path.join(kbDir(name), 'principles');
  if (!await exists(legacy)) return 0;
  const target = holyDir(name);
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(legacy).catch(() => []);
  let moved = 0;
  for (const ent of entries) {
    if (!ent.endsWith('.json')) continue;
    const fromPath = path.join(legacy, ent);
    const data = await readJsonSafe(fromPath, null);
    if (!data) {
      // Unparseable — just move raw, no migration
      await fs.copyFile(fromPath, path.join(target, ent));
      await fs.unlink(fromPath);
      moved++;
      continue;
    }
    // Derive canonical id from the existing data; filename is the source of truth
    const filenameId = ent.replace(/\.json$/, '');
    let finalId = data.id || filenameId;
    // Preserve traceability
    if (data.topic && data.topic !== finalId) data.legacyTopic = data.topic;
    data.id = finalId;
    data.space = 'holy';
    const targetFilename = `${finalId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
    const toPath = path.join(target, targetFilename);
    if (await exists(toPath)) {
      // Already migrated (e.g. from a prior run); just delete the source
      await fs.unlink(fromPath);
      continue;
    }
    await writeJsonAtomic(toPath, data);
    await fs.unlink(fromPath);
    moved++;
  }
  // Remove the now-empty legacy directory
  const remaining = await fs.readdir(legacy).catch(() => []);
  if (remaining.length === 0) await fs.rmdir(legacy).catch(() => {});
  return moved;
}

/* --- Back-compat: legacy principle API --- */
// These delegate to holy-space knowledge so old callers keep working during
// the transition. Prefer the new listKnowledge / readKnowledge / etc.

export async function listPrinciples(name) {
  return listKnowledge(name, 'holy');
}
export async function readPrinciple(name, topic) {
  return readKnowledge(name, 'holy', topic);
}
