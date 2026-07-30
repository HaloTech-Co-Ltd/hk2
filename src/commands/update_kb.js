/**
 * update-kb mode: incremental KB update.
 *
 * Reads meta.json to get KB info, calls buildIndex({full:false}) which uses
 * sha256-based file diffing (only changed files are re-parsed; inverted index
 * and callgraph are rebuilt every time since their cost is much lower than parsing).
 */
import { getMeta } from '../../lib/store/kb_store.js';
import { resolveKbName } from '../kb_name.js';

export async function updateKb() {
  const kbName = await resolveKbName();
  const meta = await getMeta(kbName);
  if (!meta) {
    console.error(`Error: no KB found for "${kbName}". Run --mode=build-kb first.`);
    process.exit(2);
  }

  const { buildIndex } = await import('../../lib/index/indexer.js');

  console.error(`[update-kb] kb: ${kbName}`);
  console.error(`[update-kb] source: ${meta.sourcePath}`);
  console.error(`[update-kb] sourceRoot: ${meta.sourceRoot || '(none)'}`);

  const stats = await buildIndex(kbName, {
    full: false,
    onProgress: ({ done, total, file }) => {
      if (done % 25 === 0 || done === total) {
        console.error(`[${done}/${total}] ${file || ''}`);
      }
    },
  });

  console.error(`done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
}
