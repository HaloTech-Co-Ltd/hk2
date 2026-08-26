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
 * Per-request knowledge graph: organize KB-retrieved "related entities" into
 * LLM-consumable context.
 *
 * Core hk2 idea: BEFORE forwarding the user's request to the LLM, use the KB
 * to narrow the relevant code / docs / call-graph edges into a knowledge
 * graph. This bounds the LLM's exploration and reduces hallucination.
 *
 * Graph contents:
 *   - matchedPrinciples: hit principle topics (intro + keyFiles + keySymbols)
 *   - symbols: BM25-retrieved top-K related symbols (file:line + signature + snippet)
 *   - neighbors: call-graph 1-hop neighbors (bounded to avoid noise)
 *   - docs: matched docs under the project's docs/ dir (by keyword hit)
 *   - summary: human-readable graph summary string
 *
 * Budget control: maxChars cap; symbols truncated by score when exceeded.
 */

import { tokenizeText } from '../index/text_tokenizer.js';
import { codeSearch } from '../retrieval/code_search.js';
import { matchPrinciples } from '../retrieval/context_builder.js';
import { resolveKbContentPaths, filterAllowedPaths } from '../config/setting.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fs_atomic.js';

/**
 * Build the per-request knowledge graph.
 *
 * @param {object} rt     Loaded KBRuntime
 * @param {string} query  User's raw query (also used for display)
 * @param {{topK?: number, maxChars?: number, neighbors?: number, project?: object, retrievalQuery?: string, rewrite?: object}} [opts]
 *   - retrievalQuery: pre-rewritten query to feed BM25 (when LLM query rewrite is enabled).
 *                     Falls back to the raw `query` if omitted.
 *   - rewrite: optional {functionNames, keywords, intent, fallback} from rewriteQuery; surfaced in graph.
 * @returns {Promise<object>} graph
 */
export async function buildRequestGraph(rt, query, opts = {}) {
  const topK = opts.topK ?? 12;
  const maxChars = opts.maxChars ?? 65536;
  const maxNeighbors = opts.neighbors ?? 8;
  const retrievalQuery = opts.retrievalQuery || query;

  // 1. Knowledge entries — Holy-first priority (Holy-over-Eden).
  //    Holy and Eden are matched SEPARATELY so Holy entries always rank
  //    ahead of Eden in the injected context regardless of match scores.
  //    Each matched Eden entry is cross-checked against ALL Holy entries
  //    (title containment / keyword overlap > 0.6 — the same heuristic as
  //    crossCheckEntries in src/slash/kb.js); a conflicting Eden entry is
  //    suppressed from the context and recorded in graph.conflicts so the
  //    caller can notify the user and sync Eden at end of turn.
  let holyEntries, edenEntries;
  if (rt.knowledgeBySpace) {
    holyEntries = rt.knowledgeBySpace.holy || [];
    edenEntries = rt.knowledgeBySpace.eden || [];
  } else {
    const all = rt.allKnowledge?.() || [];
    holyEntries = all.filter(e => e.space !== 'eden');
    edenEntries = all.filter(e => e.space === 'eden');
  }
  // Holy-over-Eden priority: an Eden entry already stamped supersededBy
  // holy:<id> (by a previous turn's syncConflictingEden) is RETIRED from
  // retrieval entirely — it must never re-enter the context, re-trigger the
  // conflict warning, or re-print the end-of-turn "synced" reminder on every
  // subsequent turn. The Holy entry it pointed to remains authoritative.
  const activeEden = edenEntries.filter(e => !e.supersededBy);
  const matchedHoly = matchPrinciples(holyEntries, retrievalQuery)
    .map(m => ({ ...m, principle: { ...m.principle, space: 'holy' } }));
  const matchedEden = [];
  const conflicts = [];
  for (const m of matchPrinciples(activeEden, retrievalQuery)) {
    const tagged = { ...m, principle: { ...m.principle, space: 'eden' } };
    const holyDup = findHolyConflict(tagged.principle, holyEntries);
    if (holyDup) {
      conflicts.push({
        eden: { id: tagged.principle.id || tagged.principle.topic, title: tagged.principle.title },
        holy: { id: holyDup.id || holyDup.topic, title: holyDup.title },
      });
      continue; // Holy takes precedence — suppress the Eden entry.
    }
    matchedEden.push(tagged);
  }
  const matchedKnowledge = [...matchedHoly, ...matchedEden];

  // 2. Symbol retrieval (BM25 on the rewritten query)
  const results = codeSearch(rt, retrievalQuery, { topK: Math.max(topK, 20), expandGraph: false });

  // 3. Call-graph 1-hop neighbors (legacy)
  const neighborSymbols = [];
  const seenIds = new Set(results.map(r => r.id));
  const cg = rt.callgraph?.byId || [];
  let neighborBudget = maxNeighbors;
  for (const r of results.slice(0, 6)) {
    if (neighborBudget <= 0) break;
    const edges = cg[r.id] || [];
    for (const id of edges) {
      if (neighborBudget <= 0) break;
      if (seenIds.has(id)) continue;
      const sym = rt.getSymbolById(id);
      if (!sym) continue;
      seenIds.add(id);
      neighborSymbols.push({
        id: sym.id,
        name: sym.name,
        kind: sym.kind,
        fileId: sym.fileId,
        filePath: rt.getFilePath(sym.fileId),
        lineStart: sym.lineStart,
        signature: sym.signature,
        via: r.name,
      });
      neighborBudget--;
    }
  }

  // 4. Knowledge-graph context: bounded call chains + class membership
  //    for the top-K BM25 hits. Computed only when the graph is loaded.
  const callChains = [];
  const classContext = [];
  if (rt.graph) {
    for (const r of results.slice(0, 4)) {
      const chain = rt.getCallChain(r.id, 'both', 2, 6);
      if (chain.forward.length === 0 && chain.backward.length === 0) continue;
      callChains.push({
        symbolId: r.id,
        name: r.name,
        filePath: r.filePath,
        lineStart: r.lineStart,
        forward: chain.forward.map(n => ({
          name: n.name, kind: n.kind,
          filePath: n.filePath, lineStart: n.lineStart,
        })),
        backward: chain.backward.map(n => ({
          name: n.name, kind: n.kind,
          filePath: n.filePath, lineStart: n.lineStart,
        })),
      });
    }
    // Class membership for the top symbols that live inside a class
    const seenClass = new Set();
    for (const r of results.slice(0, 6)) {
      const container = rt.getContainingClass(r.id);
      if (!container) continue;
      if (seenClass.has(container.id)) continue;
      seenClass.add(container.id);
      const members = rt.getClassMembers(container.id).slice(0, 12).map(m => ({
        name: m.name, kind: m.kind, lineStart: m.lineStart,
        signature: (m.signature || '').slice(0, 100),
      }));
      classContext.push({
        id: rt.toSymbolId(container.id),
        name: container.name,
        qualName: container.qualName,
        kind: container.kind,
        filePath: container.filePath,
        lineStart: container.lineStart,
        superClassNames: container.superClassNames || [],
        implementsNames: container.implementsNames || [],
        members,
      });
    }
  }

  // 5. Project docs
  const docs = opts.project ? await collectDocs(rt, query, opts.project) : [];
  // 5b. Structured doc index: query-relevant tables, doc cross-references,
  //     and doc mentions of the top retrieved code symbols.
  const docTablesRaw = rt.findTables ? rt.findTables(retrievalQuery, 4) : [];
  const docSymbolRefs = [];
  if (rt.docIndex && results.length > 0) {
    const seen = new Set();
    for (const r of results.slice(0, 8)) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      const refs = rt.getSymbolDocRefs(r.name);
      if (refs.length === 0) continue;
      docSymbolRefs.push({
        symbol: r.name,
        symbolId: r.id,
        filePath: r.filePath,
        mentions: refs.slice(0, 5).map(m => ({ doc: m.doc, kind: m.kind, ...(m.lang ? { lang: m.lang } : {}) })),
      });
      if (docSymbolRefs.length >= 6) break;
    }
  }
  const docGraphInfo = rt.docIndex ? {
    docCount: rt.docIndex.meta?.docCount || 0,
    linkCount: rt.docIndex.meta?.linkCount || 0,
    tableCount: rt.docIndex.meta?.tableCount || 0,
  } : null;

  // 6. Assemble graph object
  const graph = {
    query,
    knowledge: matchedKnowledge.map(m => ({
      id: m.principle.id || m.principle.topic,
      space: m.principle.space || 'holy',
      title: m.principle.title,
      intro: m.principle.intro || '',
      keyFiles: m.principle.keyFiles || [],
      keySymbols: m.principle.keySymbols || [],
    })),
    principles: matchedKnowledge.map(m => ({
      topic: m.principle.id || m.principle.topic,
      title: m.principle.title,
      intro: m.principle.intro || '',
      keyFiles: m.principle.keyFiles || [],
      keySymbols: m.principle.keySymbols || [],
    })),
    symbols: results.slice(0, topK).map(r => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      fileId: r.fileId,
      filePath: r.filePath,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      signature: r.signature,
      score: r.score,
      snippet: r.snippet,
    })),
    neighbors: neighborSymbols,
    callChains,
    classes: classContext,
    docs,
    docTables: [],
    docSymbolRefs,
    docGraphInfo,
    conflicts,
    rewrite: opts.rewrite || null,
    retrievalQuery,
  };

  // Content-permission pass (setting.json). "The project KB is equivalent to
  // the project's files": rows carrying real file CONTENT — symbol snippets
  // (first lines of the symbol body, mirrored from the index snapshot),
  // project-doc texts, and doc tables — are suppressed when their source
  // file is denied 'r'. Pure metadata (names/kinds/signatures/line ranges/
  // knowledge entries, which are curated HK2 state, not file mirrors)
  // passes through so navigation keeps working.
  const contentPaths = [
    ...graph.symbols.map(s => s.filePath),
    ...docs.map(d => d.path),
    ...docTablesRaw.map(t => t.doc),
  ];
  const contentAbsByPath = await resolveKbContentPaths(contentPaths);
  const contentAllowed = await filterAllowedPaths(
    [...contentAbsByPath.values()].filter(Boolean));
  const contentOk = (filePath) => {
    const abs = contentAbsByPath.get(filePath);
    return Boolean(abs && contentAllowed.has(abs));
  };
  for (const s of graph.symbols) {
    if (!contentOk(s.filePath)) s.snippet = undefined;
  }
  graph.docs = docs.filter(d => contentOk(d.path));
  graph.docTables = docTablesRaw.filter(t => contentOk(t.doc));

  graph.summary = summarize(graph);
  return graph;
}

function findHolyConflict(edenEntry, holyEntries) {
  const eTitle = String(edenEntry.title || '').toLowerCase();
  const eKws = new Set((edenEntry.keywords || []).map(k => String(k).toLowerCase()));
  for (const h of holyEntries) {
    const hTitle = String(h.title || '').toLowerCase();
    if (eTitle && hTitle && (eTitle.includes(hTitle) || hTitle.includes(eTitle))) return h;
    const hKws = new Set((h.keywords || []).map(k => String(k).toLowerCase()));
    if (eKws.size > 0 && hKws.size > 0) {
      let ov = 0;
      for (const k of eKws) if (hKws.has(k)) ov++;
      if (ov / Math.min(eKws.size, hKws.size) > 0.6) return h;
    }
  }
  return null;
}

function summarize(g) {
  const parts = [];
  parts.push(`${g.symbols.length} related symbol(s)`);
  if (g.knowledge?.length) parts.push(`${g.knowledge.length} knowledge entr${g.knowledge.length === 1 ? 'y' : 'ies'}`);
  if (g.neighbors.length) parts.push(`${g.neighbors.length} call-graph neighbor(s)`);
  if (g.callChains?.length) parts.push(`${g.callChains.length} call chain(s)`);
  if (g.classes?.length) parts.push(`${g.classes.length} class context(s)`);
  if (g.docs.length) parts.push(`${g.docs.length} project doc(s)`);
  if (g.docTables?.length) parts.push(`${g.docTables.length} doc table(s)`);
  if (g.docSymbolRefs?.length) parts.push(`${g.docSymbolRefs.length} doc-referenced symbol(s)`);
  if (g.docGraphInfo && (g.docGraphInfo.linkCount > 0 || g.docGraphInfo.tableCount > 0)) {
    parts.push(`${g.docGraphInfo.docCount} indexed doc(s): ${g.docGraphInfo.linkCount} cross-ref link(s), ${g.docGraphInfo.tableCount} table(s)`);
  }
  if (g.conflicts?.length) parts.push(`${g.conflicts.length} eden conflict(s) suppressed by holy`);
  return parts.join(' / ');
}

/**
 * Render the graph into the "KB context" block of the LLM system prompt.
 * Truncated within maxChars budget. Principles first, related symbols next,
 * neighbors and docs last.
 */
export function renderRequestGraph(graph, opts = {}) {
  const maxChars = opts.maxChars ?? 65536;
  const parts = [];
  let used = 0;

  parts.push('# Project knowledge base context');
  parts.push(`(query: ${graph.query})`);
  if (graph.rewrite && !graph.rewrite.fallback) {
    parts.push(`(rewritten retrieval query: ${graph.rewrite.rewrittenQuery})`);
    if (graph.rewrite.intent) parts.push(`(intent: ${graph.rewrite.intent})`);
  }
  parts.push(`(hits: ${graph.summary})`);
  parts.push('');

  if (graph.knowledge?.length > 0) {
    parts.push('## Knowledge entries (Holy first, then Eden — Holy takes precedence)');
    parts.push('');
    for (const k of graph.knowledge) {
      const seg = `### ${k.title} [${k.space}] (${k.id})\n${k.intro}\n`;
      if (used + seg.length > maxChars * 0.35) continue;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  } else if (graph.principles?.length > 0) {
    // Back-compat: caller passed graph without a `knowledge` field but with principles
    parts.push('## Knowledge entries');
    parts.push('');
    for (const p of graph.principles) {
      const seg = `### ${p.title} (${p.topic})\n${p.intro}\n`;
      if (used + seg.length > maxChars * 0.35) continue;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.conflicts?.length > 0) {
    parts.push('## Holy-over-Eden conflicts (Eden suppressed)');
    parts.push('');
    parts.push('Holy Space takes precedence over Eden Space. These Eden entries matched the query but conflict with a Holy entry, so they were removed from this context — follow the Holy entry instead:');
    parts.push('');
    for (const c of graph.conflicts) {
      parts.push(`- eden "${c.eden.title}" (${c.eden.id}) is superseded by holy "${c.holy.title}" (${c.holy.id}).`);
    }
    parts.push('');
  }

  if (graph.symbols.length > 0) {
    parts.push('## Related symbols (ranked by relevance)');
    parts.push('');
    for (const s of graph.symbols) {
      const seg = formatSymbolSegment(s);
      if (used + seg.length > maxChars) {
        const remain = maxChars - used;
        if (remain > 200) {
          parts.push(seg.slice(0, remain) + '\n... (truncated)\n');
          used = maxChars;
        }
        break;
      }
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.neighbors.length > 0) {
    parts.push('## Call-graph neighbors (1-hop)');
    parts.push('');
    for (const n of graph.neighbors) {
      const seg = `- ${n.name} [${n.kind}]  ${n.filePath}:${n.lineStart}  (via ${n.via})\n  ${n.signature || ''}\n`;
      if (used + seg.length > maxChars) break;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.callChains?.length > 0) {
    parts.push('## Call chains (2-hop, knowledge graph)');
    parts.push('');
    for (const c of graph.callChains) {
      const callers = c.backward.map(b => `${b.name} (${b.filePath}:${b.lineStart})`).join(', ');
      const callees = c.forward.map(f => `${f.name} (${f.filePath}:${f.lineStart})`).join(', ');
      const seg = `### ${c.name}  ${c.filePath}:${c.lineStart}\n`
                + (callers ? `  ← called by: ${callers}\n` : '')
                + (callees ? `  → calls: ${callees}\n` : '')
                + (!callers && !callees ? '  (no edges within hop budget)\n' : '');
      if (used + seg.length > maxChars * 0.6) break;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.classes?.length > 0) {
    parts.push('## Class membership');
    parts.push('');
    for (const cls of graph.classes) {
      const memberList = cls.members.map(m => `${m.name} [${m.kind}]`).join(', ');
      const seg = `### ${cls.qualName || cls.name} [${cls.kind}]  ${cls.filePath}:${cls.lineStart}\n`
                + (cls.superClassNames?.length ? `  extends: ${cls.superClassNames.join(', ')}\n` : '')
                + (cls.implementsNames?.length ? `  implements: ${cls.implementsNames.join(', ')}\n` : '')
                + `  members: ${memberList}\n`;
      if (used + seg.length > maxChars * 0.7) break;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.docs.length > 0) {
    parts.push('## Project docs');
    parts.push('');
    for (const d of graph.docs) {
      if (used + d.text.length > maxChars) break;
      parts.push(`### ${d.path}\n${d.text}\n`);
      used += d.text.length + d.path.length + 10;
    }
    parts.push('');
  }

  if (graph.docTables?.length > 0) {
    parts.push('## Structured doc tables (config params / compatibility matrices)');
    parts.push('');
    for (const t of graph.docTables) {
      const align = Array.isArray(t.align) && t.align.some(Boolean) ? t.align : null;
      const lines = [`### ${t.doc}${t.section ? ` — ${t.section}` : ''} (score ${t.score})`];
      if (align) lines.push(`(column alignment: ${t.align.map(a => a || '-').join(', ')})`);
      const header = `| ${t.headers.join(' | ')} |`;
      const sep = `| ${t.headers.map((_, i) => {
        const a = align ? align[i] : null;
        if (a === 'center') return ':---:';
        if (a === 'right') return '---:';
        return '---';
      }).join(' | ')} |`;
      lines.push(header, sep);
      for (const row of t.rows.slice(0, 12)) lines.push(`| ${row.join(' | ')} |`);
      if (t.rows.length > 12) lines.push(`… (+${t.rows.length - 12} more rows)`);
      const seg = lines.join('\n') + '\n';
      if (used + seg.length > maxChars * 0.8) break;
      parts.push(seg);
      used += seg.length;
    }
    parts.push('');
  }

  if (graph.docSymbolRefs?.length > 0) {
    parts.push('## Doc ↔ code symbol references');
    parts.push('');
    parts.push('Documents mentioning the retrieved code symbols (kind=code: inside a fenced code example; kind=prose: in text):');
    for (const ref of graph.docSymbolRefs) {
      const ms = ref.mentions.map(m => `${m.doc} [${m.kind}${m.lang ? ':' + m.lang : ''}]`).join(', ');
      parts.push(`- ${ref.symbol} (${ref.filePath}): mentioned in ${ms}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

function formatSymbolSegment(s) {
  const limit = 800;
  let body = s.snippet || s.signature || '';
  if (body.length > limit) body = body.slice(0, limit) + '\n/* ... truncated ... */';
  const lang = inferLang(s.filePath);
  return `### ${s.name} [${s.kind}]  ${s.filePath}:${s.lineStart}\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
}

function inferLang(filePath) {
  if (!filePath) return '';
  const m = /\.([A-Za-z0-9]+)$/i.exec(filePath);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (['c', 'h'].includes(ext)) return 'c';
  if (['cpp', 'cc', 'hpp', 'cxx'].includes(ext)) return 'cpp';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['jsx'].includes(ext)) return 'jsx';
  if (['ts'].includes(ext)) return 'typescript';
  if (['tsx'].includes(ext)) return 'tsx';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'java') return 'java';
  if (ext === 'kt') return 'kotlin';
  if (ext === 'scala') return 'scala';
  if (ext === 'rb') return 'ruby';
  if (ext === 'php') return 'php';
  if (ext === 'swift') return 'swift';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'bash';
  return '';
}

/**
 * Collect docs relevant to the query from the project's docs/ directory.
 * Strategy: rank by query-token hits in filename + content, take top 3.
 *
 * Looked-up paths: ${sourcePath}/docs, ${sourcePath}/${sourceRoot}/docs,
 * ${sourcePath}/doc, ${sourcePath}/${sourceRoot}/doc.
 */
async function collectDocs(rt, query, project) {
  const docsRoots = [];
  if (project.sourcePath) {
    docsRoots.push(path.join(project.sourcePath, 'docs'));
    docsRoots.push(path.join(project.sourcePath, project.sourceRoot || '', 'docs'));
    docsRoots.push(path.join(project.sourcePath, 'doc'));
    docsRoots.push(path.join(project.sourcePath, project.sourceRoot || '', 'doc'));
  }
  const queryTokens = new Set(tokenizeText(query));
  if (queryTokens.size === 0) return [];

  const candidates = [];
  for (const root of docsRoots) {
    if (!await exists(root)) continue;
    const files = await walkDocs(root, 50).catch(() => []);
    candidates.push(...files);
  }
  if (candidates.length === 0) return [];

  const scored = [];
  for (const f of candidates) {
    let text = '';
    try { text = await fs.readFile(f, 'utf8'); } catch { continue; }
    if (text.length > 50000) text = text.slice(0, 50000);
    const fileName = path.basename(f);
    const nameHit = tokenizeText(fileName).filter(t => queryTokens.has(t)).length;
    const sample = text.slice(0, 8192);
    const contentHit = tokenizeText(sample).filter(t => queryTokens.has(t)).length;
    if (nameHit + contentHit === 0) continue;
    scored.push({ path: f, text, score: nameHit * 5 + contentHit });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => ({
    path: path.relative(project.sourcePath, s.path),
    text: s.text.slice(0, 4000),
    score: s.score,
  }));
}

async function walkDocs(root, limit, depth = 0) {
  if (depth > 4 || limit <= 0) return [];
  const out = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch { return []; }
  for (const ent of entries) {
    if (limit <= 0) break;
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const sub = await walkDocs(p, limit, depth + 1);
      out.push(...sub);
      limit -= sub.length;
    } else if (/\.(md|txt|rst|adoc)$/i.test(ent.name)) {
      out.push(p);
      limit--;
    }
  }
  return out;
}
