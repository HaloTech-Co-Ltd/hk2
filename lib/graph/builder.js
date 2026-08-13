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
 * Knowledge graph builder — consumes Symbol[] and produces nodes + edges.
 *
 * Edge kinds:
 *   - contains : parent class/namespace → child method/field
 *   - inherits : derived class → base class
 *   - imports  : file-level → file-level (resolved by basename heuristic)
 *   - calls    : caller → callee (resolved via name index)
 *
 * Identifier resolution priority for calls/imports:
 *   1. same file (by qualName or name)
 *   2. same directory
 *   3. any file (first match wins)
 *
 * Same disambiguation rule as the legacy lib/index/callgraph.js:pickBest.
 */

const CONTAINER_KINDS = new Set(['class', 'struct', 'interface', 'enum']);

/**
 * Build a knowledge graph from symbols.
 *
 * @param {Array} symbols    Symbol[] (rich shape from ast.js)
 * @param {Object} filesById fileId → { path, ... } (from files.json)
 * @returns {{ nodes, edges, byKind, byQual }}
 *   nodes:   Map<id, node>
 *   edges:   { calls: {src: [dst]}, imports: {...}, inherits: {...}, contains: {...} }
 *   byKind:  { kind: [ids] }
 *   byQual:  { qualName: id }
 */
export function buildKnowledgeGraph(symbols, filesById = {}) {
  const nodes = new Map();
  const byName = new Map();       // name → [{ id, fileId, dir }]
  const byQual = {};              // qualName → id
  const byKind = {};              // kind → [id]
  const firstNodeByFile = new Map();  // fileId → first node id (import-edge anchor)

  // Index files by basename (extension stripped) for import resolution.
  // The key is normalized to match basenameOfImport(), which also strips the
  // extension (import './foo.js' -> 'foo', file 'foo.js' -> 'foo'). A single
  // key may map to several file ids when the same basename appears with
  // different extensions (foo.js + foo.ts); the import loop resolves that via
  // same-directory preference then first-wins.
  const filesByBasename = new Map();  // basename(no ext) -> [fileId]
  for (const [fid, f] of Object.entries(filesById)) {
    if (!f || !f.path) continue;
    const base = basenameOfNoExt(f.path);
    if (!base) continue;
    if (!filesByBasename.has(base)) filesByBasename.set(base, []);
    filesByBasename.get(base).push(parseInt(fid, 10));
  }

  // 1) Emit nodes
  for (const s of symbols) {
    if (!s || !s.id) continue;
    const filePath = filesById[s.fileId]?.path || '';
    const node = {
      id: 'g' + s.id,
      symbolId: s.id,
      kind: s.kind || 'function',
      name: s.name || '',
      qualName: s.qualName || s.name || '',
      fileId: s.fileId,
      filePath,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      signature: s.signature || '',
      docString: s.docString || '',
      modifiers: Array.isArray(s.modifiers) ? s.modifiers : [],
      superClassNames: Array.isArray(s.superClass) ? s.superClass : [],
      implementsNames: Array.isArray(s.implements) ? s.implements : [],
      parentSymbolId: s.parentSymbolId ?? null,
    };
    nodes.set(node.id, node);
    if (!firstNodeByFile.has(s.fileId)) firstNodeByFile.set(s.fileId, node.id);
    if (!byKind[node.kind]) byKind[node.kind] = [];
    byKind[node.kind].push(node.id);
    if (node.qualName) byQual[node.qualName] = node.id;
    if (node.name) {
      if (!byName.has(node.name)) byName.set(node.name, []);
      byName.get(node.name).push({
        id: node.id,
        fileId: node.fileId,
        dir: dirOf(filePath),
      });
    }
  }

  // 2) Build edges
  const edges = {
    contains: {},
    inherits: {},
    imports: {},
    calls: {},
  };

  // 2a) contains (parent container → member)
  for (const [, node] of nodes) {
    if (!node.parentSymbolId) continue;
    const parentId = 'g' + node.parentSymbolId;
    if (!nodes.has(parentId)) continue;
    pushEdge(edges.contains, parentId, node.id);
  }

  // 2b) inherits (superClass + implements)
  for (const [, node] of nodes) {
    if (!CONTAINER_KINDS.has(node.kind)) continue;
    const srcDir = dirOf(node.filePath);
    for (const name of [...node.superClassNames, ...node.implementsNames]) {
      const target = resolveByName(name, node.fileId, srcDir, byName);
      if (target) pushEdge(edges.inherits, node.id, target);
    }
  }

  // 2c) imports (file-level)
  // Aggregate imports[] per file from any symbol that carries them
  const importsByFile = new Map();  // fileId → Set<name>
  for (const s of symbols) {
    if (!s.imports || s.imports.length === 0) continue;
    if (!importsByFile.has(s.fileId)) importsByFile.set(s.fileId, new Set());
    for (const imp of s.imports) importsByFile.get(s.fileId).add(imp);
  }
  for (const [fileId, names] of importsByFile) {
    const srcFile = filesById[fileId];
    if (!srcFile) continue;
    const srcPath = srcFile.path;
    const srcDir = dirOf(srcPath);
    // Each import name → resolve to a file by basename heuristic
    for (const name of names) {
      const base = basenameOfImport(name);
      const candidates = filesByBasename.get(base) || [];
      if (candidates.length === 0) continue;
      // Prefer same directory
      const sameDir = candidates.filter(fid => dirOf(filesById[fid].path) === srcDir);
      const pick = sameDir[0] ?? candidates[0];
      // Emit edge between any symbol in src file → any symbol in dst file
      // We pick the first node of each file as the anchor.
      const srcNode = firstNodeByFile.get(fileId) ?? null;
      const dstNode = firstNodeByFile.get(pick) ?? null;
      if (srcNode && dstNode && srcNode !== dstNode) {
        pushEdge(edges.imports, srcNode, dstNode);
      }
    }
  }

  // 2d) calls (from references[])
  for (const s of symbols) {
    if (!s.id || !Array.isArray(s.references) || s.references.length === 0) continue;
    const callerId = 'g' + s.id;
    if (!nodes.has(callerId)) continue;
    const callerNode = nodes.get(callerId);
    const srcDir = dirOf(callerNode.filePath);
    const seen = new Set();
    for (const refName of s.references) {
      if (refName === s.name) continue;
      const target = resolveByName(refName, s.fileId, srcDir, byName);
      if (!target || target === callerId || seen.has(target)) continue;
      seen.add(target);
      pushEdge(edges.calls, callerId, target);
    }
  }

  return { nodes, edges, byKind, byQual };
}

function pushEdge(adj, src, dst) {
  if (!adj[src]) adj[src] = [];
  // de-dup
  if (!adj[src].includes(dst)) adj[src].push(dst);
}

function basenameOf(p) {
  if (!p) return '';
  const parts = p.split('/');
  return parts[parts.length - 1] || '';
}

function basenameOfNoExt(p) {
  const b = basenameOf(p);
  if (!b) return '';
  const dot = b.lastIndexOf('.');
  if (dot > 0) return b.slice(0, dot);
  return b;
}

function basenameOfImport(name) {
  // import "foo/bar.js" -> bar ; import './foo' -> foo ; import 'node:fs' -> '' (skip).
  // Node.js built-in / scheme-prefixed modules are never local files, so bail
  // out early to avoid e.g. 'node:fs/promises' matching a local 'promises.js'.
  // Java/Python symbol imports (com.foo.Bar / from x import y) have no slash
  // and carry a symbol suffix; they rarely resolve against filesByBasename
  // and are left to fall through naturally.
  if (!name) return '';
  let s = name.replace(/^['"`]|['"`]$/g, '');
  if (!s) return '';
  if (s.startsWith('node:')) return '';
  const parts = s.split('/');
  let last = parts[parts.length - 1] || '';
  // drop extension
  const dot = last.lastIndexOf('.');
  if (dot > 0) last = last.slice(0, dot);
  return last;
}

function dirOf(p) {
  if (!p) return '';
  const parts = p.split('/');
  parts.pop();
  return parts.join('/');
}

function resolveByName(name, srcFileId, srcDir, byName) {
  const candidates = byName.get(name);
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].id;
  // Single pass: same file wins immediately; remember first same-dir as fallback.
  let firstSameDir = null;
  for (const c of candidates) {
    if (c.fileId === srcFileId) return c.id;
    if (firstSameDir === null && srcDir && c.dir === srcDir) firstSameDir = c.id;
  }
  if (firstSameDir !== null) return firstSameDir;
  // 3. first candidate
  return candidates[0].id;
}

