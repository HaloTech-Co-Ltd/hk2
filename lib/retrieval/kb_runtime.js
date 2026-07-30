/**
 * KB runtime cache: lazily loads the BM25 code index, knowledge graph,
 * per-space knowledge entries (Holy + Eden), legacy callgraph, and file
 * metadata into memory. Reused across calls. One cache entry per KB.
 */

import {
  readInverted, readFiles, readCallgraph, readStats,
  readSymbolsShard, listSymbolShards,
  listKnowledge, readKnowledge,
  migrateLegacyPrinciples,
} from '../store/kb_store.js';
import { readGraph } from '../store/graph_store.js';
import { buildReverse, bfsForward } from '../graph/traverse.js';
import { BM25Index } from '../index/bm25.js';
import log from '../util/log.js';

const cache = new Map();  // kbName → Runtime

export async function getRuntime(kbName) {
  if (cache.has(kbName)) return cache.get(kbName);
  const rt = new KBRuntime(kbName);
  await rt.load();
  cache.set(kbName, rt);
  return rt;
}

export function dropRuntime(kbName) {
  cache.delete(kbName);
}

export class KBRuntime {
  constructor(name) {
    this.name = name;
    // --- Index Space ---
    this.bm = null;                  // BM25 over code symbols
    this.files = null;               // { byId, byPath, nextId }
    this.callgraph = null;           // { byId, nameIndex } (legacy, derived)
    this.stats = null;
    this.symbolsByFile = new Map();  // fileId → Symbol[]
    // --- Knowledge graph ---
    this.graph = null;               // { nodes: Map, edges, byKind, byQual, reverse }
    // --- Holy / Eden Spaces ---
    this.knowledge = new Map();
    this.knowledgeBySpace = { holy: [], eden: [] };
    // Back-compat aliases
    this.principles = new Map();
    this._principleList = [];
  }

  async load() {
    const t0 = Date.now();

    try {
      const moved = await migrateLegacyPrinciples(this.name);
      if (moved > 0) log.info(`KB ${this.name} migrated ${moved} legacy principle(s) to holy/`);
    } catch (err) {
      log.warn('legacy principle migration failed', { kb: this.name, msg: err.message });
    }

    const [invObj, files, graphObj, stats, graphData] = await Promise.all([
      readInverted(this.name),
      readFiles(this.name),
      readCallgraph(this.name),
      readStats(this.name),
      readGraph(this.name),
    ]);
    if (!invObj) throw new Error(`KB ${this.name} inverted index missing`);
    this.bm = BM25Index.deserialize(invObj);
    this.files = files;
    this.callgraph = graphObj || { byId: {}, nameIndex: {} };
    this.stats = stats || {};

    // Load symbols
    const shards = await listSymbolShards(this.name);
    for (const s of shards) {
      const data = await readSymbolsShard(this.name, s.shardNum);
      for (const sym of data.symbols || []) {
        if (!this.symbolsByFile.has(sym.fileId)) this.symbolsByFile.set(sym.fileId, []);
        this.symbolsByFile.get(sym.fileId).push(sym);
      }
    }

    // Load knowledge graph
    if (graphData) {
      const nodesMap = new Map(Object.entries(graphData.nodes || {}));
      const edges = graphData.edges || { calls: {}, imports: {}, inherits: {}, contains: {} };
      this.graph = {
        nodes: nodesMap,
        edges,
        byKind: graphData.byKind || {},
        byQual: graphData.byQual || {},
        reverse: {
          calls: buildReverse(edges.calls || {}),
          imports: buildReverse(edges.imports || {}),
          inherits: buildReverse(edges.inherits || {}),
          contains: buildReverse(edges.contains || {}),
        },
      };
    } else {
      this.graph = null;
    }

    // Load knowledge entries
    const [holy, eden] = await Promise.all([
      listKnowledge(this.name, 'holy'),
      listKnowledge(this.name, 'eden'),
    ]);
    this.knowledgeBySpace.holy = holy;
    this.knowledgeBySpace.eden = eden;
    this.knowledge = new Map();
    for (const entry of holy) {
      this.knowledge.set(entry.id, { entry, space: 'holy' });
      this.principles.set(entry.id, entry);
      if (entry.topic && entry.topic !== entry.id) this.principles.set(entry.topic, entry);
    }
    for (const entry of eden) {
      this.knowledge.set(entry.id, { entry, space: 'eden' });
    }
    this._principleList = holy;

    log.info(`KB ${this.name} runtime loaded`, {
      ms: Date.now() - t0,
      symbols: this.bm.N,
      graphNodes: this.graph ? this.graph.nodes.size : 0,
      holy: holy.length,
      eden: eden.length,
    });
  }

  /* --- Symbol lookups (Index Space) --- */

  getSymbolById(id) {
    const m = /^(\d+):/.exec(id);
    if (!m) return null;
    const fid = parseInt(m[1], 10);
    const syms = this.symbolsByFile.get(fid);
    if (!syms) return null;
    return syms.find(s => s.id === id) || null;
  }

  getSymbolsByName(name) {
    const ids = (this.callgraph.nameIndex && this.callgraph.nameIndex[name]) || [];
    return ids.map(id => this.getSymbolById(id)).filter(Boolean);
  }

  getFilePath(fileId) {
    const f = this.files.byId[fileId];
    return f ? f.path : null;
  }

  getFileId(path) {
    return this.files.byPath[path] || null;
  }

  listFiles() {
    return Object.values(this.files.byId).sort((a, b) => a.path.localeCompare(b.path));
  }

  getSymbolsInFile(fileId) {
    return this.symbolsByFile.get(fileId) || [];
  }

  /* --- Knowledge graph lookups --- */

  /** Convert symbol id ("12:345") → node id ("g12:345"). */
  toNodeId(symbolId) {
    return symbolId && !symbolId.startsWith('g') ? 'g' + symbolId : symbolId;
  }

  /** Convert node id → symbol id. */
  toSymbolId(nodeId) {
    return nodeId && nodeId.startsWith('g') ? nodeId.slice(1) : nodeId;
  }

  getNode(symbolIdOrNodeId) {
    if (!this.graph) return null;
    const id = this.toNodeId(symbolIdOrNodeId);
    return this.graph.nodes.get(id) || null;
  }

  /** Forward call chain (callees). Returns node records excluding the start. */
  getCallees(symbolId, maxDepth = 2, maxNodes = 20) {
    if (!this.graph) return [];
    const start = this.toNodeId(symbolId);
    const result = bfsForward(start, this.graph.edges.calls, { maxDepth, maxNodes });
    const out = [];
    for (const id of result.nodes) {
      if (id === start) continue;
      const node = this.graph.nodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  /** Backward call chain (callers). */
  getCallers(symbolId, maxDepth = 2, maxNodes = 20) {
    if (!this.graph) return [];
    const start = this.toNodeId(symbolId);
    const result = bfsForward(start, this.graph.reverse.calls, { maxDepth, maxNodes });
    const out = [];
    for (const id of result.nodes) {
      if (id === start) continue;
      const node = this.graph.nodes.get(id);
      if (node) out.push(node);
    }
    return out;
  }

  /** Bounded call chain in both directions. */
  getCallChain(symbolId, direction = 'both', maxDepth = 2, maxNodes = 20) {
    const out = { forward: [], backward: [] };
    if (!this.graph) return out;
    if (direction === 'forward' || direction === 'both') {
      out.forward = this.getCallees(symbolId, maxDepth, maxNodes);
    }
    if (direction === 'backward' || direction === 'both') {
      out.backward = this.getCallers(symbolId, maxDepth, maxNodes);
    }
    return out;
  }

  /** Walk up `contains` edges to the nearest class/struct/interface. */
  getContainingClass(symbolId) {
    if (!this.graph) return null;
    let cursor = this.toNodeId(symbolId);
    const visited = new Set([cursor]);
    while (cursor) {
      const parents = this.graph.reverse.contains[cursor] || [];
      if (parents.length === 0) return null;
      let next = null;
      for (const pid of parents) {
        const pnode = this.graph.nodes.get(pid);
        if (!pnode) continue;
        if (['class', 'struct', 'interface', 'enum'].includes(pnode.kind)) return pnode;
        if (!visited.has(pid)) { visited.add(pid); next = pid; }
      }
      cursor = next;
    }
    return null;
  }

  /** Walk down `contains` edges — members of a class/interface. */
  getClassMembers(classSymbolId) {
    if (!this.graph) return [];
    const start = this.toNodeId(classSymbolId);
    const childIds = this.graph.edges.contains[start] || [];
    return childIds.map(id => this.graph.nodes.get(id)).filter(Boolean);
  }

  /** Classes/structs that inherit from / implement the given node. */
  getImplementations(interfaceSymbolId) {
    if (!this.graph) return [];
    const start = this.toNodeId(interfaceSymbolId);
    const childIds = this.graph.reverse.inherits[start] || [];
    return childIds.map(id => this.graph.nodes.get(id)).filter(Boolean);
  }

  /** Files whose imports include the file containing the given symbol. */
  getImporters(symbolId) {
    if (!this.graph) return [];
    const start = this.toNodeId(symbolId);
    const ids = this.graph.reverse.imports[start] || [];
    return ids.map(id => this.graph.nodes.get(id)).filter(Boolean);
  }

  getImportees(symbolId) {
    if (!this.graph) return [];
    const start = this.toNodeId(symbolId);
    const ids = this.graph.edges.imports[start] || [];
    return ids.map(id => this.graph.nodes.get(id)).filter(Boolean);
  }

  /** Look up a node by qualified name. */
  resolveByQualName(qualName) {
    if (!this.graph) return null;
    const id = this.graph.byQual[qualName];
    return id ? this.graph.nodes.get(id) : null;
  }

  /** Substring search across node names + qualified names. */
  searchNodes(query, limit = 20) {
    if (!this.graph) return [];
    const q = query.toLowerCase();
    const out = [];
    for (const [, node] of this.graph.nodes) {
      if ((node.name && node.name.toLowerCase().includes(q)) ||
          (node.qualName && node.qualName.toLowerCase().includes(q))) {
        out.push(node);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** List nodes of a given kind. */
  getNodesByKind(kind, limit = 100) {
    if (!this.graph) return [];
    const ids = (this.graph.byKind[kind] || []).slice(0, limit);
    return ids.map(id => this.graph.nodes.get(id)).filter(Boolean);
  }

  /** Fan-in + fan-out degree for a node. */
  getNodeDegree(symbolId) {
    if (!this.graph) return { in: 0, out: 0 };
    const id = this.toNodeId(symbolId);
    return {
      in: (this.graph.reverse.calls[id] || []).length,
      out: (this.graph.edges.calls[id] || []).length,
    };
  }

  /* --- Knowledge lookups (Holy + Eden Spaces) --- */

  findKnowledge(id) {
    return this.knowledge.get(id) || null;
  }

  allKnowledge() {
    return [...this.knowledgeBySpace.holy, ...this.knowledgeBySpace.eden];
  }

  reloadKnowledge(entry, space) {
    if (!entry || !entry.id) return;
    this.knowledgeBySpace.holy = this.knowledgeBySpace.holy.filter(e => e.id !== entry.id);
    this.knowledgeBySpace.eden = this.knowledgeBySpace.eden.filter(e => e.id !== entry.id);
    this.knowledgeBySpace[space].push(entry);
    this.knowledge.set(entry.id, { entry, space });
    if (space === 'holy') {
      this.principles.set(entry.id, entry);
      if (entry.topic && entry.topic !== entry.id) this.principles.set(entry.topic, entry);
      const idx = this._principleList.findIndex(e => e.id === entry.id);
      if (idx >= 0) this._principleList[idx] = entry;
      else this._principleList.push(entry);
    } else {
      this.principles.delete(entry.id);
      this._principleList = this._principleList.filter(e => e.id !== entry.id);
    }
  }
}
