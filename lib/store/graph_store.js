/**
 * Knowledge graph persistence — sharded JSON files under
 * ~/.hk2/kb/<projectId>/graph/.
 *
 * Layout:
 *   graph/
 *     nodes.json          id → node record
 *     edges.calls.json    srcId → [dstId, ...]
 *     edges.imports.json  srcId → [dstId, ...]
 *     edges.inherits.json srcId → [dstId, ...]
 *     edges.contains.json srcId → [dstId, ...]
 *     by_kind.json        kind → [nodeId, ...]
 *     by_qual.json        qualName → nodeId
 *     meta.json           { nodeCount, edgeCounts, version, updatedAt }
 *
 * The on-disk edges are forward-only. Inverse traversal (getCallers etc.)
 * is computed at load time by the runtime (lib/retrieval/kb_runtime.js)
 * into reverse adjacency lists.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, exists, rmrf } from '../util/fs_atomic.js';
import { kbDir } from './kb_store.js';

export const EDGE_KINDS = ['calls', 'imports', 'inherits', 'contains'];

export function graphDir(name) { return path.join(kbDir(name), 'graph'); }
export function nodesPath(name) { return path.join(graphDir(name), 'nodes.json'); }
export function edgesPath(name, kind) { return path.join(graphDir(name), `edges.${kind}.json`); }
export function byKindPath(name) { return path.join(graphDir(name), 'by_kind.json'); }
export function byQualPath(name) { return path.join(graphDir(name), 'by_qual.json'); }
export function graphMetaPath(name) { return path.join(graphDir(name), 'meta.json'); }

export async function createGraphDir(name) {
  await import('node:fs/promises').then(fs => fs.mkdir(graphDir(name), { recursive: true }));
}

/**
 * Write a complete graph snapshot. Overwrites previous state.
 *
 * @param {string} name             KB name (project id)
 * @param {object} graph            { nodes, edges, byKind, byQual }
 * @param {Map|Object} graph.nodes  id → node record (Map or plain object)
 * @param {Object} graph.edges      { calls, imports, inherits, contains } — each srcId → [dstId]
 * @param {Object} graph.byKind     kind → [nodeId]
 * @param {Object} graph.byQual     qualName → nodeId
 */
export async function writeGraph(name, graph) {
  await createGraphDir(name);
  const nodesObj = graph.nodes instanceof Map
    ? Object.fromEntries(graph.nodes)
    : (graph.nodes || {});

  await writeJsonAtomic(nodesPath(name), nodesObj);

  for (const kind of EDGE_KINDS) {
    const data = (graph.edges && graph.edges[kind]) || {};
    await writeJsonAtomic(edgesPath(name, kind), data);
  }

  await writeJsonAtomic(byKindPath(name), graph.byKind || {});
  await writeJsonAtomic(byQualPath(name), graph.byQual || {});

  const edgeCounts = {};
  for (const kind of EDGE_KINDS) {
    const e = (graph.edges && graph.edges[kind]) || {};
    edgeCounts[kind] = Object.values(e).reduce((acc, lst) => acc + (Array.isArray(lst) ? lst.length : 0), 0);
  }

  await writeJsonAtomic(graphMetaPath(name), {
    nodeCount: Object.keys(nodesObj).length,
    edgeCounts,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Read the graph snapshot. Returns { nodes, edges, byKind, byQual, meta } or null.
 * `nodes` is returned as a plain object; callers convert to Map if needed.
 */
export async function readGraph(name) {
  if (!await exists(graphDir(name))) return null;
  const [nodes, meta] = await Promise.all([
    readJsonSafe(nodesPath(name), {}),
    readJsonSafe(graphMetaPath(name), null),
  ]);
  if (Object.keys(nodes).length === 0 && !meta) return null;

  const edges = {};
  for (const kind of EDGE_KINDS) {
    edges[kind] = await readJsonSafe(edgesPath(name, kind), {});
  }
  const byKind = await readJsonSafe(byKindPath(name), {});
  const byQual = await readJsonSafe(byQualPath(name), {});

  return { nodes, edges, byKind, byQual, meta };
}

export async function deleteGraph(name) {
  if (await exists(graphDir(name))) await rmrf(graphDir(name));
}
