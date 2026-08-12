/**
 * Per-loop KB-hit-rate and estimated-token-savings statistics.
 *
 * Goal: after each agent turn (loop), report how often the agent reached for a
 * KB tool instead of a bash/grep/read fallback, and roughly how many tokens
 * that saved versus the no-KB world.
 *
 * Two signals are tracked per loop:
 *   - kbCalls         : tool calls whose name starts with `kb_` (the agent
 *                       chose the indexed path). Cached cache-hits count too -
 *                       the agent still *asked* the KB.
 *   - fallbackCalls  : tool calls that look like the no-KB discovery path:
 *                       `bash` commands that are search-like (grep/find/cat
 *                       on source files) and `read` of source files. These
 *                       are what the agent would have done *more* of without
 *                       the KB, so they form the denominator with kbCalls.
 *
 *   hit rate = kbCalls / (kbCalls + fallbackCalls)
 *
 * Estimated token savings: for each kb_* call that returns references to real
 * source files, we stat those files (what a no-KB agent would have read in
 * full) and subtract the bytes the KB actually returned. The difference is
 * "information the agent did NOT have to pull off disk", converted to tokens
 * at the project's ~4 chars/token estimate. The result is labelled `~` since
 * it is an estimate, not a measurement.
 *
 * Knowledge tools (kb_knowledge / kb_search_knowledge / kb_save_knowledge)
 * don't replace a file read, so they contribute to the hit-rate denominator
 * but not to the byte-savings sum.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXT_RE =
  /\.(c|h|cpp|cc|hpp|cxx|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|scala|rb|php|swift|sh|bash|zsh|y|l|md|markdown|txt|rst|adoc|json|yaml|yml|html|htm)$/i;

/**
 * Does this bash command look like the no-KB discovery path (grep/find/cat on
 * source files)? Mirrors KbFirstGuard._isBashSearch in tools.js so the stats
 * use the same definition as the kb-first policy hint.
 */
function isBashSearch(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  const c = cmd.toLowerCase();
  if (/\b(grep|rg|ag|ack|git\s+grep|fd|locate|find)\b/.test(c)) return true;
  if (/\b(cat|sed|awk|head|tail|wc|nl|cut|paste|xxd|od|strings)\b/.test(c) && SOURCE_EXT_RE.test(c)) return true;
  return false;
}

/**
 * Is this tool call a "fallback" the agent would have done more of without KB?
 * Returns the parsed args (for bash) or null when not a fallback.
 */
export function fallbackKind(call) {
  if (!call || typeof call.name !== 'string') return null;
  if (call.name === 'bash') {
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch { return null; }
    }
    const cmd = args && typeof args.command === 'string' ? args.command : '';
    return isBashSearch(cmd) ? 'bash' : null;
  }
  if (call.name === 'read') {
    let args = call.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args || '{}'); } catch { return null; }
    }
    const p = args && typeof args.path === 'string' ? args.path : '';
    return p && SOURCE_EXT_RE.test(p) ? 'read' : null;
  }
  return null;
}

/**
 * Collect referenced source-file paths from a KB tool result. Each kb_* tool
 * embeds `filePath` on its returned records (search results, symbols, neighbors,
 * call-chain nodes, callers/importers/derived, class members' implementations,
 * etc.). We de-duplicate per call so a search that returns 5 hits in the same
 * file counts that file once.
 *
 * Returns a Set of project-relative path strings.
 */
function extractKbResultFilePaths(result) {
  const paths = new Set();
  if (!result || typeof result !== 'object') return paths;

  const push = (v) => {
    if (typeof v === 'string' && v && SOURCE_EXT_RE.test(v)) paths.add(v);
  };

  // Top-level filePath (kb_class, kb_callchain start, kb_outline path).
  push(result.filePath);
  push(result.path);

  // Array shapes with a `filePath` field per item.
  // kb_search -> results[]; kb_symbol -> symbols[]; kb_neighbors -> neighbors[];
  // kb_refs -> callers[]/importers[]/derived[]; kb_implements -> implementations[];
  // kb_class -> implementations[]; kb_callchain -> forward[]/backward[].
  const lists = [
    result.results, result.symbols, result.neighbors, result.outline,
    result.callers, result.importers, result.derived, result.implementations,
    result.forward, result.backward,
  ];
  for (const arr of lists) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === 'object') push(item.filePath);
      }
    }
  }
  return paths;
}

/**
 * Estimate token savings for one kb_* call.
 *
 *   savings = est_tokens(sum of referenced-file sizes) - est_tokens(bytes the
 *             KB actually returned for this call)
 *
 * Clamped at >= 0 (a KB result can legitimately be larger than a tiny file,
 * but that's not "savings lost" - the agent still used the index). Returns the
 * savings in tokens plus the set of file paths it stat'd (for caching).
 *
 * `root` is the project source path, used to resolve relative paths to disk.
 * `estTokens` is the chars->tokens estimator (passed in to avoid a hard dep on
 * the LLM client module here).
 */
async function estimateCallSavings(result, root, estTokens) {
  const paths = extractKbResultFilePaths(result);
  let diskBytes = 0;
  if (root && paths.size > 0) {
    // Stat each referenced file; ignore misses (deleted / out-of-tree).
    const stats = await Promise.all(
      [...paths].map((p) => fs.stat(path.join(root, p)).then((s) => s.size, () => 0)),
    );
    diskBytes = stats.reduce((a, b) => a + b, 0);
  }
  const resultBytes = Buffer.byteLength(JSON.stringify(result || {}), 'utf8');
  const diskTokens = estTokens(diskBytes);
  const resultTokens = estTokens(resultBytes);
  return Math.max(0, diskTokens - resultTokens);
}

/**
 * Build the per-loop stats snapshot from the recorded call list. `kbCalls` and
 * `fallbackCalls` are arrays of `{ call, result }` captured by the agent loop.
 * Resolves file sizes in parallel for speed.
 */
export async function buildKbStats(kbCalls, fallbackCalls, { root, estTokens }) {
  const kb = kbCalls.length;
  const fb = fallbackCalls.length;
  const denom = kb + fb;

  let savings = 0;
  // Only inspect results that actually succeeded (have a `result` payload).
  await Promise.all(
    kbCalls.map(async ({ result }) => {
      if (result && typeof result === 'object' && !result.error) {
        savings += await estimateCallSavings(result, root, estTokens);
      }
    }),
  );

  return {
    kbCalls: kb,
    fallbackCalls: fb,
    hitRate: denom > 0 ? kb / denom : 0,
    estimatedTokensSaved: savings,
  };
}

export const _internals = { isBashSearch, fallbackKind, extractKbResultFilePaths, estimateCallSavings };
