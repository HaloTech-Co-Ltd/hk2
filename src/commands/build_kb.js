/**
 * build-kb mode: create / rebuild the knowledge base (full re-index).
 *
 * Flow:
 *   1. Resolve --source (default ../../../, relative to cwd) to absolute path
 *   2. Resolve kb name: current project id if it has KB; else 'default'
 *   3. addKb(kbName, sourcePath, { root: sourceRoot }) → write meta.json
 *   4. buildIndex(kbName, { full: true }) → walk/parse/BM25/callgraph pipeline
 *
 * Recommended: use interactive mode + /kb init, which uses project id as KB name automatically.
 */
import path from 'node:path';
import { exists } from '../../lib/util/fs_atomic.js';
import { resolveKbName } from '../kb_name.js';

export async function buildKb(flags) {
  const sourcePathRaw = flags.source || '../../../';
  const sourcePath = path.resolve(process.cwd(), sourcePathRaw);
  const sourceRoot = flags['source-root'] || '';

  if (!await exists(sourcePath)) {
    console.error(`Error: source path not found: ${sourcePath}`);
    console.error(`  (resolved from --source=${sourcePathRaw}, cwd=${process.cwd()})`);
    process.exit(2);
  }

  const kbName = await resolveKbName();
  const { addKb } = await import('../../lib/index/registry.js');
  const { buildIndex } = await import('../../lib/index/indexer.js');

  console.error(`[build-kb] kb name: ${kbName}`);
  console.error(`[build-kb] source: ${sourcePath}`);
  console.error(`[build-kb] sourceRoot: ${sourceRoot || '(none)'}`);
  console.error(`[build-kb] kb dir: ~/.hk2/kb/${kbName}/`);

  await addKb(kbName, sourcePath, { root: sourceRoot });

  const stats = await buildIndex(kbName, {
    full: true,
    onProgress: ({ done, total, file }) => {
      if (done % 25 === 0 || done === total) {
        console.error(`[${done}/${total}] ${file || ''}`);
      }
    },
  });

  console.error(`done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
}
