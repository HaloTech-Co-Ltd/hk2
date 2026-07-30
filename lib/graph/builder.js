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

  // Index files by basename for import resolution
  const filesByBasename = new Map();  // basename → [fileId]
  for (const [fid, f] of Object.entries(filesById)) {
    if (!f || !f.path) continue;
    const base = basenameOf(f.path);
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
    };
    nodes.set(node.id, node);
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

  // 2a) contains
  for (const [, node] of nodes) {
    // For container nodes, derive members via parentSymbolId
  }
  for (const [, node] of nodes) {
    if (!node.symbolId) continue;
    // Look up the source symbol to read parentSymbolId
    const sym = symbols.find(s => s.id === node.symbolId.slice(1));
    if (!sym || !sym.parentSymbolId) continue;
    const parentId = 'g' + sym.parentSymbolId;
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
      const srcNode = pickFirstNodeInFile(nodes, fileId);
      const dstNode = pickFirstNodeInFile(nodes, pick);
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

function basenameOfImport(name) {
  // import "foo/bar.js" → bar.js ; import './foo' → foo ; from foo.bar import x → (skip)
  if (!name) return '';
  const stripped = name.replace(/^['"`]|['"`]$/g, '');
  const parts = stripped.split('/');
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
  // 1. same file
  const sameFile = candidates.filter(c => c.fileId === srcFileId);
  if (sameFile.length > 0) return sameFile[0].id;
  // 2. same directory
  if (srcDir) {
    const sameDir = candidates.filter(c => c.dir === srcDir);
    if (sameDir.length > 0) return sameDir[0].id;
  }
  // 3. first candidate
  return candidates[0].id;
}

function pickFirstNodeInFile(nodes, fileId) {
  for (const [, node] of nodes) {
    if (node.fileId === fileId) return node.id;
  }
  return null;
}
