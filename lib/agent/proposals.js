/**
 * In-memory proposal stash for ast_edit's preview/accept flow.
 *
 * ast_edit runs as a dry-run: it computes the proposed writes but does NOT
 * touch the filesystem. Instead it stages them here and returns a proposalId.
 * `resolve` then either applies (writing all files atomically-ish) or
 * discards (dropping the entry).
 *
 * Bounds:
 *   - Max 16 active proposals per process (LRU eviction when exceeded).
 *   - 10-minute TTL; stale entries are pruned on access.
 *
 * No persistence: a crashed process drops everything. That's intentional —
 * proposals are previews, not authoritative state.
 */

const MAX_PROPOSALS = 16;
const TTL_MS = 10 * 60 * 1000;

/** Map<proposalId, { files: [{ path, abs, next, prev, tag }], createdAt, lastTouched }> */
const stash = new Map();

function now() { return Date.now(); }

function prune() {
  const t = now();
  for (const [id, entry] of stash) {
    if (t - entry.createdAt > TTL_MS) stash.delete(id);
  }
  // LRU evict oldest if still over capacity
  while (stash.size > MAX_PROPOSALS) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, entry] of stash) {
      if (entry.lastTouched < oldestTs) { oldestTs = entry.lastTouched; oldestId = id; }
    }
    if (oldestId) stash.delete(oldestId); else break;
  }
}

export function stage(id, files) {
  prune();
  stash.set(id, { files, createdAt: now(), lastTouched: now() });
}

export function get(id) {
  const entry = stash.get(id);
  if (!entry) return null;
  if (now() - entry.createdAt > TTL_MS) {
    stash.delete(id);
    return null;
  }
  entry.lastTouched = now();
  return entry;
}

export function drop(id) {
  return stash.delete(id);
}

export function listIds() {
  prune();
  return Array.from(stash.keys());
}

export function size() {
  return stash.size;
}

/** Test-only: clear all. */
export function _reset() {
  stash.clear();
}
