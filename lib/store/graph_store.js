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
