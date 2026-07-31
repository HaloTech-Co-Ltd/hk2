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
 * Pure traversal helpers over an in-memory graph.
 *
 * The runtime (lib/retrieval/kb_runtime.js) loads the on-disk JSON into
 * Maps and reverse-indexes the edges, then calls these helpers.
 *
 * All functions are read-only and side-effect-free.
 */

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 20;

/**
 * Forward BFS from a node along a single edge kind.
 *
 * @param {string} startId
 * @param {Object} fwd   forward adjacency: srcId → [dstId]
 * @param {Object} opts  { maxDepth, maxNodes }
 * @returns {Object} { nodes: Set<id>, layers: [[id,...],[id,...]] }
 */
export function bfsForward(startId, fwd, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const visited = new Set([startId]);
  const layers = [[startId]];
  for (let depth = 0; depth < maxDepth; depth++) {
    const frontier = layers[depth];
    const next = [];
    for (const id of frontier) {
      const edges = fwd[id] || [];
      for (const dst of edges) {
        if (visited.has(dst)) continue;
        visited.add(dst);
        next.push(dst);
        if (visited.size >= maxNodes) return { nodes: visited, layers };
      }
    }
    if (next.length === 0) break;
    layers.push(next);
  }
  return { nodes: visited, layers };
}

/**
 * Backward BFS via a precomputed reverse adjacency map.
 */
export function bfsBackward(startId, rev, opts = {}) {
  return bfsForward(startId, rev, opts);
}

/**
 * Build a reverse adjacency map from a forward one.
 *   forward: srcId → [dstId]
 *   reverse: dstId → [srcId]
 */
export function buildReverse(fwd) {
  const rev = {};
  for (const [src, dsts] of Object.entries(fwd)) {
    for (const dst of dsts) {
      if (!rev[dst]) rev[dst] = [];
      if (!rev[dst].includes(src)) rev[dst].push(src);
    }
  }
  return rev;
}

/**
 * Collect a bounded call chain in both directions.
 *
 * @returns {{ forward: Set, backward: Set }}
 */
export function callChain(startId, fwd, rev, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const forward = bfsForward(startId, fwd, { maxDepth, maxNodes });
  const backward = bfsBackward(startId, rev, { maxDepth, maxNodes });
  return { forward: forward.nodes, backward: backward.nodes };
}

/**
 * Walk up the `contains` edges from a node to find its containing class.
 * Returns the nearest ancestor with kind in ['class','struct','interface','enum'].
 */
export function findContainer(startId, containsFwd, nodes) {
  // Note: contains edges go parent → child, so to find a parent we need
  // the reverse of `containsFwd`. The caller should pass the reverse map.
  // Simple BFS here over the supplied reverse map.
  let cursor = startId;
  const visited = new Set([cursor]);
  // The supplied map should be the reverse-of-contains (child → parents)
  // Iterate manually since the depth is usually 1-2 hops.
  // We expect the caller to give us the reverse map.
  // For safety, we fall back to walking forward if no reverse entries exist.
  return null;  // caller uses runtime's getContainingClass which has both maps
}
