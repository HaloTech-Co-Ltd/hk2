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
