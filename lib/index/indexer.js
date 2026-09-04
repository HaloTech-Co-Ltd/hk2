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
 * KB indexing pipeline:
 *   walk → parse (AST or regex) → BM25 + callgraph + knowledge-graph → persist
 *   document files → parse → Eden entries
 *
 * Features:
 *   - Tree-sitter AST parsing via lib/parser/ast.js (falls back to regex)
 *   - .gitignore filtering via lib/index/gitignore.js
 *   - Document parsing via lib/parser/doc_parser.js (routed to Eden Space)
 *   - Knowledge graph build via lib/graph/builder.js
 *   - Checkpointing every N files (resumable on Ctrl-C)
 *   - End-of-build LLM-authored Eden summaries (project-overview /
 *     architecture-diagram / architecture-decisions; LLM required,
 *     skippable via --skip-summary)
 *
 * Incremental strategy: sha256-based file diffing; only changed files are
 * re-parsed. Indexes (BM25, callgraph, graph) are rebuilt every time.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import log from '../util/log.js';
import { sha256 } from '../util/hash.js';
import { asyncPool } from '../util/async_pool.js';
import { parseSource } from '../parser/ast.js';
import { parseDocument, isDocFile, compactDoc } from '../parser/doc_parser.js';
import { walkMultiRoot } from './walker.js';
import { loadGitignore } from './gitignore.js';
import { Checkpoint } from './checkpoint.js';

import { tokenizeSymbol } from './text_tokenizer.js';
import { BM25Index } from './bm25.js';
import { buildCallGraph } from './callgraph.js';
import { buildKnowledgeGraph } from '../graph/builder.js';

import {
  getMeta, saveMeta, readFiles, writeFiles, writeStats, readStats,
  writeInverted, writeCallgraph, writeSymbolsShard, readSymbolsShard, listSymbolShards,
  writeKnowledge, deleteKb, listKnowledge, deleteKnowledge, rebuildKnowledgeIndex,
} from '../store/kb_store.js';
import { writeGraph, deleteGraph } from '../store/graph_store.js';
import { writeDocIndex, readDocIndex } from '../store/doc_index_store.js';
import { buildDocGraph, proseIdentifiers } from './doc_graph.js';
import { exists } from '../util/fs_atomic.js';

import { PARSER_VERSION } from './registry.js';
import { resolveIndexConcurrency } from './concurrency.js';

/**
 * Build or incrementally update the index.
 *
 * @param {string} kbName
 * @param {object} [opts]
 * @param {boolean} [opts.full=false]             Force re-parse of all files
 * @param {function} [opts.onProgress]            ({done, total, file, symbols}) → void
 * @param {number} [opts.checkpointInterval=100]  Save checkpoint every N files
 * @param {boolean} [opts.resume=true]            Load existing checkpoint
 * @param {boolean} [opts.checkpoint=true]        Write a checkpoint at all
 * @param {boolean} [opts.skipSummary=false]      Skip LLM-authored Eden summaries
 * @param {object} [opts.llm]                     LLMClient for summaries (optional)
 * @param {function} [opts.streamLLM]             Streaming wrapper for summaries
 * @returns {Promise<object>} stats
 */
export async function buildIndex(kbName, opts = {}) {
  const meta = await getMeta(kbName);
  if (!meta) throw new Error(`KB ${kbName} not found`);

  const t0 = Date.now();
  const filesIndex = await readFiles(kbName);
  const allFiles = [];
  const sourceRootAbs = meta.sourceRoot ? path.join(meta.sourcePath, meta.sourceRoot) : meta.sourcePath;
  const extraRoots = meta.extraRoots || [];
  const roots = [
    { absPath: sourceRootAbs, name: '' },
    ...extraRoots.map(r => ({ absPath: path.join(meta.sourcePath, r.relRoot), name: r.name })),
  ];

  // Load .gitignore from the primary source path
  const gitignoreFilter = await loadGitignore(meta.sourcePath).catch(() => null);
  if (gitignoreFilter) log.info(`loaded .gitignore from ${meta.sourcePath}`);

  log.info(`walking ${roots.length} roots`, {
    primary: sourceRootAbs,
    extras: extraRoots,
    include: meta.includeGlobs, exclude: meta.excludeGlobs,
  });

  for await (const f of walkMultiRoot(roots, {
    includeGlobs: meta.includeGlobs,
    excludeGlobs: meta.excludeGlobs,
    gitignoreFilter,
  })) {
    allFiles.push(f);
  }
  log.info(`walked ${allFiles.length} files`);

  // Checkpoint setup
  const cp = new Checkpoint(kbName, {
    interval: opts.checkpointInterval ?? parseInt(process.env.HK2_KB_CHECKPOINT_INTERVAL || '100', 10),
    enabled: opts.checkpoint !== false,
  });
  if (opts.resume !== false) await cp.load();

  // Decide which files need parsing
  const toParse = [];
  const cpHits = new Set();
  // Documents skipped by the incremental hash check but already tracked by the
  // files index. A KB upgrading to the doc graph on an incremental build has
  // no _docInputs to merge artifacts from, so those docs are re-parsed this
  // one time — otherwise the doc graph comes up empty and the stale-entry
  // cleanup below would mass-delete the pre-existing doc: Eden entries. Full
  // rebuilds (--full) already re-parse everything, so they need no rescue.
  const skippedTrackedDocs = new Set();
  // Rescue condition: the doc graph has no reusable per-doc artifacts — either
  // no doc_index.json at all (pre-feature KB) or one with empty _docInputs
  // (e.g. a previous upgrade run emptied it before this fix). Both leave
  // nothing to merge from, so unchanged docs must be re-parsed this one time.
  const prevDocIndex = await readDocIndex(kbName).catch(() => null);
  const prevDocInputsUsable = !!(prevDocIndex && Array.isArray(prevDocIndex._docInputs) && prevDocIndex._docInputs.length > 0);
  if (!opts.full && !prevDocInputsUsable) {
    for (const f of allFiles) {
      if (filesIndex.byPath[f.path] === undefined) continue;   // brand-new files parse anyway
      if (isDocFile(path.extname(f.path).slice(1).toLowerCase()) || isDocFile(path.basename(f.path))) {
        skippedTrackedDocs.add(f.path);
      }
    }
  }
  // proseIdents backfill: inputs persisted BEFORE the identifier-set field
  // existed carry a text already truncated at the 20k cap and no proseIdents —
  // tail-located prose mentions are unrecoverable from the stored text, so
  // those docs are re-parsed once through the same rescue channel.
  if (!opts.full && prevDocInputsUsable) {
    const needReparse = new Set(prevDocIndex._docInputs
      .filter(d => d && d.path && typeof d.text === 'string' && d.text.length >= 20000 && !Array.isArray(d.proseIdents))
      .map(d => d.path));
    if (needReparse.size > 0) {
      for (const f of allFiles) {
        if (needReparse.has(f.path) && filesIndex.byPath[f.path] !== undefined) skippedTrackedDocs.add(f.path);
      }
    }
  }
  for (const f of allFiles) {
    let hash;
    try { hash = sha256(await fs.readFile(f.absPath, 'utf8')); }
    catch (err) { log.warn('skip file', { path: f.path, msg: err.message }); continue; }

    // Resume from checkpoint: skip files already processed in this run
    if (cp.has(f.path, hash)) {
      cpHits.add(f.path);
      // A checkpoint left by an INTERRUPTED upgrade run must not bypass the
      // pre-doc-graph rescue above: those docs still need their one-time
      // deep parse, exactly like hash-skipped ones.
      if (skippedTrackedDocs.delete(f.path)) toParse.push({ ...f, hash });
      continue;
    }
    // Skip unchanged files (unless --full)
    const existing = filesIndex.byPath[f.path];
    if (!opts.full && existing !== undefined && filesIndex.byId[existing] && filesIndex.byId[existing].hash === hash) {
      if (skippedTrackedDocs.delete(f.path)) toParse.push({ ...f, hash });
      continue;
    }
    toParse.push({ ...f, hash });
  }
  if (skippedTrackedDocs.size > 0) {
    log.info(`doc-graph upgrade/backfill: deep-parsing ${skippedTrackedDocs.size} unchanged doc file(s)`);
  }
  if (cpHits.size > 0) {
    log.info(`checkpoint resume: ${cpHits.size} files already processed`);
    if (opts.onProgress) opts.onProgress({ done: 0, total: toParse.length, file: `[resuming from checkpoint: ${cpHits.size} files skipped]`, symbols: 0 });
  }
  log.info(`to parse: ${toParse.length} / ${allFiles.length} files`);

  // Assign/reuse fileIds for new files
  for (const f of toParse) {
    if (filesIndex.byPath[f.path] === undefined) {
      const id = filesIndex.nextId++;
      filesIndex.byPath[f.path] = id;
      filesIndex.byId[id] = { path: f.path, hash: f.hash, mtimeMs: f.mtimeMs, symbolCount: 0, lastIndexed: null };
    } else {
      const id = filesIndex.byPath[f.path];
      filesIndex.byId[id].hash = f.hash;
      filesIndex.byId[id].mtimeMs = f.mtimeMs;
    }
  }

  // Parallel parse
  const concurrency = resolveIndexConcurrency({ concurrency: opts.concurrency });
  log.info(`index parse-pool concurrency: ${concurrency}`);
  const fileDirById = {};
  const newSymbolsByFile = {};
  const docEntries = [];   // [{ id, title, intro, keyFiles, keywords, ... }]
  const docDeepParsed = []; // [{ path, links, tables, codeBlocks, text }] for the doc graph
  let parsed = 0, totalSymbols = 0, docsCount = 0;
  let lastCheckpointAt = 0;

  await asyncPool(toParse, async (f) => {
    const fileId = filesIndex.byPath[f.path];
    const ext = path.extname(f.path).slice(1).toLowerCase();

    // Document files → route to Eden Space, skip symbol indexing
    if (isDocFile(ext) || isDocFile(path.basename(f.path))) {
      try {
        const text = await fs.readFile(f.absPath, 'utf8');
        const parsed = await parseDocument(f.absPath);
        if (parsed) {
          docEntries.push({
            id: `doc:${f.path}`,
            title: `${parsed.title || path.basename(f.path)} (${f.path})`,
            intro: compactDoc(parsed),
            keyFiles: [f.path],
            keySymbols: [],
            keywords: extractDocKeywords(parsed, f.path),
            source: 'doc-parser',
            createdAt: new Date().toISOString(),
          });
          // Capture deep-parse artifacts for the doc cross-reference graph.
          // Only Markdown carries links/tables/codeBlocks today; other formats
          // still participate via prose symbol mentions (text scan below).
          docDeepParsed.push({
            path: f.path,
            links: Array.isArray(parsed.links) ? parsed.links : [],
            tables: Array.isArray(parsed.tables) ? parsed.tables : [],
            codeBlocks: Array.isArray(parsed.codeBlocks) ? parsed.codeBlocks : [],
            text: ext === 'md' || ext === 'markdown' ? text : String(parsed.text || ''),
          });
          docsCount++;
        }
      } catch (err) {
        log.warn('doc parse failed', { path: f.path, msg: err.message });
      }
      // Files index still tracks it for completeness
      filesIndex.byId[fileId].symbolCount = 0;
      filesIndex.byId[fileId].lastIndexed = new Date().toISOString();
    } else {
      // Code file → symbol extraction
      let symbols = [];
      try {
        const text = await fs.readFile(f.absPath, 'utf8');
        symbols = await parseSource(text, ext, fileId);
      } catch (err) {
        log.warn('parse failed', { path: f.path, msg: err.message });
      }
      newSymbolsByFile[fileId] = symbols;
      fileDirById[fileId] = path.dirname(f.path);
      filesIndex.byId[fileId].symbolCount = symbols.length;
      filesIndex.byId[fileId].lastIndexed = new Date().toISOString();
      totalSymbols += symbols.length;
    }

    await cp.markDone(f.path, f.hash);
    parsed++;
    if (opts.onProgress) opts.onProgress({ done: parsed, total: toParse.length, file: f.path, symbols: filesIndex.byId[fileId].symbolCount });
    await cp.saveIfDue(() => {
      if (opts.onProgress) opts.onProgress({ done: parsed, total: toParse.length, file: `[checkpoint saved: ${parsed} files]`, symbols: 0 });
    });
  }, concurrency);

  // Persist file index
  await writeFiles(kbName, filesIndex);

  // Rewrite symbol shards
  await rewriteAllShards(kbName, filesIndex, newSymbolsByFile);

  // Collect all symbols
  const allSymbols = [];
  const shardSet = new Set();
  for (const sid of Object.keys(filesIndex.byId)) {
    const fid = parseInt(sid, 10);
    shardSet.add(Math.floor(fid / 256));
  }
  for (const shardNum of shardSet) {
    const shard = await readSymbolsShard(kbName, shardNum);
    if (shard && shard.symbols) allSymbols.push(...shard.symbols);
  }
  log.info(`collected ${allSymbols.length} symbols total`);

  // Rebuild BM25
  const bm = new BM25Index();
  for (const sym of allSymbols) {
    const tokens = tokenizeSymbol(sym);
    bm.addDoc(sym.id, tokens);
  }
  bm.finalize();
  await writeInverted(kbName, bm.serialize());

  // Legacy callgraph (kept for back-compat with kb_neighbors tool)
  const legacyCallgraph = buildCallGraph(allSymbols, { fileDirById });
  await writeCallgraph(kbName, legacyCallgraph);

  // Knowledge graph (new)
  await deleteGraph(kbName).catch(() => {});
  const graph = buildKnowledgeGraph(allSymbols, filesIndex.byId);
  await writeGraph(kbName, graph);

  // Doc cross-reference graph + table index + symbol associations.
  // Requires the FULL symbol set (allSymbols), so it runs after shard
  // collection. Docs NOT re-parsed this run keep their previous deep-parse
  // records via the _docInputs merge (filtered against the current walk so
  // files deleted from the tree are dropped).
  const symbolNames = new Set(allSymbols.map(s => s.name).filter(Boolean));
  let mergedDocInputs = docDeepParsed;
  try {
    const prev = await readDocIndex(kbName);
    if (prev && Array.isArray(prev._docInputs) && prev._docInputs.length > 0) {
      const currentPaths = new Set(allFiles.map(f => f.path));
      const seenPaths = new Set(docDeepParsed.map(d => d.path));
      const stale = prev._docInputs.filter(d => d && d.path && currentPaths.has(d.path) && !seenPaths.has(d.path));
      if (stale.length > 0) mergedDocInputs = [...docDeepParsed, ...stale];
    }
  } catch { /* first run or unreadable — proceed with current docs only */ }
  const validDocPaths = new Set(mergedDocInputs.map(d => d.path));
  const docGraph = buildDocGraph({ docs: mergedDocInputs, symbolNames });
  // Persist raw per-doc inputs for future incremental merges (private field).
  // proseIdents (identifiers from the FULL prose) is persisted alongside the
  // truncated text so tail-located prose mentions survive the 20k cap.
  docGraph._docInputs = mergedDocInputs.map(d => {
    if (typeof d.text !== 'string' || d.text.length <= 20000) return d;
    return {
      path: d.path,
      links: d.links, tables: d.tables, codeBlocks: d.codeBlocks,
      text: d.text.slice(0, 20000),
      proseIdents: proseIdentifiers(d.text),
    };
  });
  await writeDocIndex(kbName, docGraph);

  // Drop doc: Eden entries whose files are no longer in the walk (deleted or
  // excluded). Without this, stale doc:<path> entries accumulate forever on
  // incremental rebuilds. Non-doc entries are never touched.
  let staleDocsRemoved = 0;
  try {
    const existing = await listKnowledge(kbName, 'eden');
    for (const e of existing) {
      if (!e || e.id?.startsWith?.('doc:') !== true) continue;
      if (e.source !== 'doc-parser') continue;   // only entries this pipeline owns
      const docPath = e.keyFiles?.[0] || e.id.slice(4);
      if (validDocPaths.has(docPath)) continue;
      const removed = await deleteKnowledge(kbName, 'eden', e.id).catch(() => false);
      if (removed) {
        staleDocsRemoved++;
        log.info('removed stale doc eden entry', { id: e.id });
      }
    }
  } catch (err) {
    log.warn('stale doc eden cleanup failed', { msg: err.message });
  }
  // Keep the on-disk eden BM25 index in sync when entries were removed.
  if (staleDocsRemoved > 0) {
    await rebuildKnowledgeIndex(kbName, 'eden').catch(err => {
      log.warn('eden knowledge index rebuild failed', { msg: err.message });
    });
  }

  log.info('doc index built', {
    docs: docGraph.meta.docCount, links: docGraph.meta.linkCount,
    tables: docGraph.meta.tableCount, symbolMentions: docGraph.meta.symbolMentionCount,
    ...(staleDocsRemoved > 0 ? { staleDocsRemoved } : {}),
  });

  // Enrich doc: Eden entries with resolved symbol names and table-header
  // keywords so kb_search_knowledge can hit precise table / symbol queries.
  for (const entry of docEntries) {
    const docPath = entry.keyFiles[0];
    const mentions = Object.entries(docGraph.symbolMentions)
      .filter(([, lst]) => lst.some(m => m.doc === docPath));
    if (mentions.length > 0) {
      // Code mentions outrank prose mentions; cap at 30 symbols per entry.
      const ranked = mentions
        .map(([name, lst]) => ({
          name,
          inCode: lst.filter(m => m.doc === docPath && m.kind === 'code').length,
          inProse: lst.filter(m => m.doc === docPath && m.kind === 'prose').length,
        }))
        .sort((a, b) => (b.inCode - a.inCode) || (b.inProse - a.inProse) || a.name.localeCompare(b.name));
      entry.keySymbols = ranked.slice(0, 30).map(r => r.name);
    }
    const docTables = docGraph.tables.filter(t => t.doc === docPath);
    if (docTables.length > 0) {
      const headerKws = new Set(entry.keywords || []);
      for (const t of docTables) {
        for (const h of t.headers) {
          for (const w of String(h).toLowerCase().split(/\W+/)) {
            if (w.length >= 3) headerKws.add(w);
          }
        }
        // First-column row values are parameter/matrix keys (e.g. `port`,
        // `maxConnections`) — index them so "which docs document X?" style
        // kb_search_knowledge queries hit the exact table.
        for (const row of t.rows.slice(0, 50)) {
          const key = String(row[0] || '').replace(/[`*]/g, '').trim();
          if (key && key.length >= 3 && key.length <= 40 && !/\s/.test(key)) headerKws.add(key.toLowerCase());
        }
      }
      entry.keywords = Array.from(headerKws).slice(0, 80);
    }
    entry.docRefs = (docGraph.referencedBy[docPath] || []).slice(0, 20);
  }

  // Write doc entries to Eden
  for (const entry of docEntries) {
    await writeKnowledge(kbName, 'eden', entry).catch(err => {
      log.warn('doc eden write failed', { id: entry.id, msg: err.message });
    });
  }

  // Stats
  const stats = {
    N: bm.N, avgdl: bm.avgdl,
    totalFiles: Object.keys(filesIndex.byId).length,
    totalSymbols: allSymbols.length,
    totalDocs: docsCount,
    docLinks: docGraph.meta.linkCount,
    docTables: docGraph.meta.tableCount,
    docSymbolMentions: docGraph.meta.symbolMentionCount,
    graphNodes: graph.nodes.size,
    graphEdges: {
      calls: countEdges(graph.edges.calls),
      imports: countEdges(graph.edges.imports),
      inherits: countEdges(graph.edges.inherits),
      contains: countEdges(graph.edges.contains),
    },
    buildDurationMs: Date.now() - t0,
    indexConcurrency: concurrency,
    parserVersion: PARSER_VERSION,
    updatedAt: new Date().toISOString(),
    uniqueTokens: bm.postings.size,
  };
  await writeStats(kbName, stats);

  meta.updatedAt = new Date().toISOString();
  meta.parserVersion = PARSER_VERSION;
  await saveMeta(kbName, meta);

  // Finalize checkpoint (still don't clear — summaries come next)
  await cp.finalize();

  // LLM-authored summaries (Eden) — optional
  if (!opts.skipSummary && (opts.llm || opts.streamLLM)) {
    try {
      const { generateSummaries } = await import('./summarize.js');
      await generateSummaries(kbName, { ...opts, stats, allSymbols, filesIndex });
    } catch (err) {
      log.warn('summary generation failed', { msg: err.message });
    }
  }

  // Success — clear the checkpoint
  await cp.clear();

  log.info(`KB ${kbName} indexed`, {
    files: stats.totalFiles, symbols: stats.totalSymbols,
    docs: docsCount, graphNodes: stats.graphNodes,
    tokens: bm.postings.size, ms: stats.buildDurationMs,
  });
  return stats;
}

function countEdges(adj) {
  if (!adj) return 0;
  return Object.values(adj).reduce((acc, lst) => acc + (Array.isArray(lst) ? lst.length : 0), 0);
}

function extractDocKeywords(parsed, filePath) {
  const out = new Set();
  out.add(path.basename(filePath).toLowerCase());
  if (parsed.title) {
    for (const w of parsed.title.toLowerCase().split(/\W+/)) {
      if (w.length >= 3) out.add(w);
    }
  }
  // Add H1/H2 headings as keywords
  if (Array.isArray(parsed.sections)) {
    for (const s of parsed.sections) {
      if (s.level <= 2 && s.title) {
        for (const w of String(s.title).toLowerCase().split(/\W+/)) {
          if (w.length >= 3) out.add(w);
        }
      }
    }
  }
  return Array.from(out).slice(0, 30);
}

async function rewriteAllShards(kbName, filesIndex, newSymbolsByFile) {
  const shardToFiles = {};
  for (const sid of Object.keys(filesIndex.byId)) {
    const fid = parseInt(sid, 10);
    const shardNum = Math.floor(fid / 256);
    if (!shardToFiles[shardNum]) shardToFiles[shardNum] = [];
    shardToFiles[shardNum].push(fid);
  }

  for (const [shardNumStr, fileIds] of Object.entries(shardToFiles)) {
    const shardNum = parseInt(shardNumStr, 10);
    const oldData = await readSymbolsShard(kbName, shardNum);
    const oldByFileId = new Map();
    for (const s of oldData.symbols || []) {
      if (!oldByFileId.has(s.fileId)) oldByFileId.set(s.fileId, []);
      oldByFileId.get(s.fileId).push(s);
    }
    const newSymbols = [];
    for (const fid of fileIds) {
      const fromNew = newSymbolsByFile[fid];
      if (fromNew) newSymbols.push(...fromNew);
      else if (oldByFileId.has(fid)) newSymbols.push(...oldByFileId.get(fid));
    }
    await writeSymbolsShard(kbName, shardNum, { symbols: newSymbols });
  }
}

export async function getIndexStats(kbName) {
  return readStats(kbName);
}

export async function dropKbData(kbName) {
  await deleteGraph(kbName).catch(() => {});
  return deleteKb(kbName);
}

export default buildIndex;
