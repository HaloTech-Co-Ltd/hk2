/**
 * Doc index persistence — a single JSON snapshot per KB:
 *   ~/.hk2/kb/<projectId>/doc_index.json
 *
 * Layout mirrors the code knowledge graph's approach (graph_store.js) but
 * keeps document cross-references SEPARATE from symbol-graph edges so
 * kb_callchain / kb_refs keep pure code semantics.
 *
 * Written by buildIndex (lib/index/indexer.js) after doc parsing; read by
 * KBRuntime (lib/retrieval/kb_runtime.js) for table/reference queries.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, exists, rmrf } from '../util/fs_atomic.js';
import { kbDir } from './kb_store.js';

export function docIndexPath(name) { return path.join(kbDir(name), 'doc_index.json'); }

export async function writeDocIndex(name, docIndex) {
  await writeJsonAtomic(docIndexPath(name), docIndex || {});
}

export async function readDocIndex(name) {
  if (!await exists(docIndexPath(name))) return null;
  return readJsonSafe(docIndexPath(name), null);
}

export async function deleteDocIndex(name) {
  if (await exists(docIndexPath(name))) await rmrf(docIndexPath(name));
}
