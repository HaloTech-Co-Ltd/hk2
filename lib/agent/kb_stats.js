/**
 * Per-loop KB-hit-rate and estimated-token-savings statistics.
 *
 * Goal: after each agent turn (loop), report how often the agent reached for a
 * KB tool (or KB-injected context) instead of a bash/grep/read fallback, and
 * roughly how many tokens that saved versus the no-KB world.
 *
 * ── Hit rate ─────────────────────────────────────────────────────────────
 *
 *   hit rate = kbCalls / (kbCalls + fallbackCalls)
 *
 *   - kbCalls        : successful KB uses. Tool calls whose name starts with
 *                      `kb_` (cache hits count too — the agent still *asked*
 *                      the KB) plus, when `prefetch` is supplied, the per-turn
 *                      knowledge-graph injection (the biggest silent KB win:
 *                      symbols/knowledge the agent never had to search for).
 *   - fallbackCalls  : calls that look like the no-KB discovery path:
 *                      search-like `bash`, the `grep` / `find` / `ast_grep`
 *                      tools, and *cold* `read`s of source files (see below).
 *
 * KB tool calls that returned `{ error }` are NOT counted in either bucket —
 * an erroring KB (e.g. graph not built) is neither a hit nor a fallback; it is
 * reported separately as `kbErrors` so the status line doesn't punish a broken
 * index the same way as an ignored index.
 *
 * ── read classification (three buckets, not one) ────────────────────────
 *
 * Counting every source-file `read` as a fallback made edit-heavy turns look
 * KB-averse even when the KB did its job (locate the file; the read is the
 * edit). Reads are now classified against the set of files the KB already
 * surfaced this loop:
 *
 *   - kb-assisted : the read result embedded a KB outline (`kbOutline: true`)
 *                   — the KB literally annotated the read.
 *   - targeted    : the path was already referenced by a KB result this loop
 *                   — the classic "KB found it, now read it to edit" flow.
 *                   Not a fallback; it replaces the grep-exploration a no-KB
 *                   agent would have done first.
 *   - cold        : neither of the above — the agent went straight to disk
 *                   without the KB. This is the real fallback signal.
 *
 * ── Estimated token savings ──────────────────────────────────────────────
 *
 *   savings = est_tokens(bytes of referenced files NOT already counted)
 *             − est_tokens(bytes the KB actually returned)
 *
 * Clamped at >= 0 per call and labelled `~` in the UI (an estimate, not a
 * measurement). Corrections vs. the naive version:
 *
 *   - Knowledge tools (kb_knowledge / kb_search_knowledge) previously
 *     contributed NOTHING because their results carry no `filePath`. They now
 *     surface `keyFiles`, and the estimator stats those — a knowledge entry's
 *     value is precisely "you didn't have to read these files".
 *   - `query` / `retrievalQuery` / `rewrite` fields are echoed metadata, not
 *     content the agent consumes; they're excluded from the returned-bytes
 *     side so a fat rewrite doesn't zero out real savings.
 *   - Files are paid out once per LOOP (cross-call dedup), not once per call:
 *     three kb_* calls all pointing at the same file no longer triple-count
 *     it. The prefetch injection's files are marked first so subsequent tool
 *     calls referencing the same files don't double-bill either.
 *
 * `root` is the project source path, used to resolve relative paths to disk.
 * `estTokens` is the chars->tokens estimator (passed in to avoid a hard dep on
 * the LLM client module here).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXT_RE =
  /\.(c|h|cpp|cc|hpp|cxx|js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|scala|rb|php|swift|sh|bash|zsh|y|l|md|markdown|txt|rst|adoc|json|yaml|yml|html|htm)$/i;

/** Result fields that are echoed metadata, not content; excluded from the
 * returned-bytes side of the savings estimate. */
const EXCLUDED_RESULT_FIELDS = new Set(['query', 'retrievalQuery', 'rewrite']);

/** Soft-capped stat cache: path -> size in bytes (cleared when it grows big). */
const FILE_SIZE_CACHE = new Map();
const FILE_SIZE_CACHE_MAX = 4096;

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

/** Parse tool-call arguments that may arrive as an object or a JSON string. */
function parseArgs(call) {
  let args = call.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args || '{}'); } catch { return null; }
  }
  return args && typeof args === 'object' ? args : null;
}

/** True when a KB tool result is an error envelope. */
function isErrorResult(result) {
  return !!result && typeof result === 'object' && typeof result.error === 'string';
}

/**
 * Loose path equality: KB paths are project-relative while read args may be
 * absolute or ./-prefixed. Two paths match when one ends with the other
 * (segment-aligned). Mirrors the matching in src/slash/kb.js readPlannedFiles.
 */
function pathsIntersect(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = a.replace(/^\.\//, '');
  const nb = b.replace(/^\.\//, '');
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/**
 * Classify a `read` of a source file against the KB context of this loop.
 * Returns 'kb-assisted' | 'targeted' | 'cold', or null when the call isn't a
 * source-file read at all.
 */
export function classifyRead(readPath, kbFilePaths, result) {
  if (!readPath || typeof readPath !== 'string' || !SOURCE_EXT_RE.test(readPath)) return null;
  if (result && typeof result === 'object' && result.kbOutline === true) return 'kb-assisted';
  if (kbFilePaths && typeof kbFilePaths[Symbol.iterator] === 'function') {
    for (const p of kbFilePaths) {
      if (pathsIntersect(readPath, p)) return 'targeted';
    }
  }
  return 'cold';
}

/**
 * Is this tool call a "fallback" the agent would have done more of without KB?
 * Returns the fallback kind ('bash' | 'grep' | 'read') or null.
 *
 * `kbFilePaths` (optional Set of paths surfaced by KB results this loop) and
 * `result` (the read's result payload) refine read classification: targeted
 * and KB-assisted reads return null — they are part of a KB-driven flow, not
 * a fallback. When omitted, every source read counts as a cold fallback
 * (legacy behavior, kept for simple callers/tests).
 */
export function fallbackKind(call, kbFilePaths = null) {
  if (!call || typeof call.name !== 'string') return null;
  if (call.name === 'bash') {
    const args = parseArgs(call);
    const cmd = args && typeof args.command === 'string' ? args.command : '';
    return isBashSearch(cmd) ? 'bash' : null;
  }
  // Standalone discovery tools count the same way as their bash equivalents.
  if (call.name === 'grep' || call.name === 'find' || call.name === 'ast_grep') return 'grep';
  if (call.name === 'read') {
    const args = parseArgs(call);
    const p = args && typeof args.path === 'string' ? args.path : '';
    // classifyRead: null = non-source read (not a fallback); 'kb-assisted' /
    // 'targeted' = part of a KB-driven flow (not a fallback); only 'cold'
    // reads — straight to disk without the KB — count as a fallback.
    // (The kbOutline signal lives on the result payload; fallbackKind sees it
    // via the record wrapper in buildKbStats.)
    return classifyRead(p, kbFilePaths, null) === 'cold' ? 'read' : null;
  }
  return null;
}

/**
 * Collect referenced source-file paths from a KB tool result. Each kb_* tool
 * embeds `filePath` on its returned records (search results, symbols, neighbors,
 * call-chain nodes, callers/importers/derived, class members' implementations,
 * etc.). Knowledge entries (kb_knowledge, and graph.knowledge from the
 * per-request prefetch) carry `keyFiles` instead — those count too, since the
 * entry's value is precisely that those files need not be read. De-duplicates
 * per result so a search that returns 5 hits in the same file counts once.
 *
 * Returns a Set of path strings (project-relative where the KB knows them).
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

  // Knowledge entries: top-level keyFiles (kb_knowledge returns the entry).
  if (Array.isArray(result.keyFiles)) result.keyFiles.forEach(push);

  // Array shapes with a `filePath` field per item.
  // kb_search -> results[]; kb_symbol -> symbols[]; kb_neighbors -> neighbors[];
  // kb_refs -> callers[]/importers[]/derived[]; kb_implements -> implementations[];
  // kb_class -> implementations[]; kb_callchain -> forward[]/backward[];
  // graph.knowledge / graph.principles carry keyFiles[] per item.
  const lists = [
    result.results, result.symbols, result.neighbors, result.outline,
    result.callers, result.importers, result.derived, result.implementations,
    result.forward, result.backward, result.callChains, result.classes,
    result.knowledge, result.principles,
  ];
  for (const arr of lists) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === 'object') {
        push(item.filePath);
        if (Array.isArray(item.keyFiles)) item.keyFiles.forEach(push);
      }
    }
  }
  return paths;
}

/** Byte length of the result minus echoed metadata fields (see module docs). */
function resultContentBytes(result) {
  if (!result || typeof result !== 'object') return 0;
  let clone;
  try {
    clone = {};
    for (const k of Object.keys(result)) {
      if (!EXCLUDED_RESULT_FIELDS.has(k)) clone[k] = result[k];
    }
    return Buffer.byteLength(JSON.stringify(clone), 'utf8');
  } catch {
    return 0;
  }
}

/** stat() a file relative to root, cached; 0 on miss. */
async function statFileBytes(root, relPath) {
  if (!root || !relPath) return 0;
  const key = root + '\u0000' + relPath;
  const hit = FILE_SIZE_CACHE.get(key);
  if (hit !== undefined) return hit;
  let size = 0;
  try { size = (await fs.stat(path.join(root, relPath))).size; } catch { size = 0; }
  if (FILE_SIZE_CACHE.size >= FILE_SIZE_CACHE_MAX) FILE_SIZE_CACHE.clear();
  FILE_SIZE_CACHE.set(key, size);
  return size;
}

async function statPathsBytes(root, paths) {
  if (!root || paths.length === 0) return 0;
  const sizes = await Promise.all([...paths].map((p) => statFileBytes(root, p)));
  return sizes.reduce((a, b) => a + b, 0);
}

/** test-only hook to reset the stat cache between test cases. */
function clearStatCacheForTests() {
  FILE_SIZE_CACHE.clear();
}

/**
 * Estimate token savings for one kb_* call against the set of files already
 * paid out this loop. `counted` is mutated: every fresh path referenced here
 * is marked so later calls referencing the same file don't re-bill it.
 *
 *   savings = est(stat bytes of FRESH paths) − est(result content bytes)
 *
 * Clamped at >= 0 (a KB result can legitimately be larger than a tiny file,
 * but that's not "savings lost" — the agent still used the index).
 */
async function estimateCallSavings(result, root, estTokens, counted = new Set()) {
  const allPaths = extractKbResultFilePaths(result);
  const fresh = [...allPaths].filter((p) => !counted.has(p));
  if (fresh.length === 0) return 0; // nothing new surfaced — no fresh savings
  for (const p of fresh) counted.add(p);
  const diskBytes = await statPathsBytes(root, fresh);
  const resultTokens = estTokens(resultContentBytes(result));
  return Math.max(0, estTokens(diskBytes) - resultTokens);
}

/**
 * Build the per-loop stats snapshot from the recorded call list. `kbCalls` and
 * `fallbackCalls` are arrays of `{ call, result, seq? }` captured by the agent
 * loop; `seq` (optional, assigned by interactive.js per call) restores exact
 * interleaving so read classification sees only the KB results that preceded
 * the read. Without `seq`, KB records are processed first (union-upfront).
 *
 * `prefetch` (optional) describes the per-turn knowledge-graph injection:
 *   { filePaths: string[], renderedChars: number }
 * When present and non-empty, it counts as ONE KB use and its files are
 * marked as counted before tool calls are processed.
 *
 * Returns { kbCalls, fallbackCalls, hitRate, estimatedTokensSaved,
 * prefetchSaved, kbErrors, coldReads, targetedReads, kbAssistedReads }.
 */
export async function buildKbStats(kbCalls, fallbackCalls, { root, estTokens, prefetch } = {}) {
  let kb = 0;
  let fallbacks = 0;
  let savings = 0;
  let prefetchSaved = 0;
  let kbErrors = 0;
  let coldReads = 0;
  let targetedReads = 0;
  let kbAssistedReads = 0;

  const counted = new Set();      // files already paid out (cross-call dedup)
  const kbFilePaths = new Set();  // files the KB surfaced (read classification)

  // 0. Per-turn prefetch injection: the KB context rendered into the system
  //    prompt before any tool call ran. It counts as one KB use; its files
  //    are marked paid so later tool calls don't double-bill them.
  if (prefetch && Array.isArray(prefetch.filePaths) && prefetch.filePaths.length > 0) {
    kb += 1;
    const fresh = prefetch.filePaths.filter((p) => !counted.has(p));
    for (const p of fresh) { counted.add(p); kbFilePaths.add(p); }
    const diskBytes = await statPathsBytes(root, fresh);
    prefetchSaved = Math.max(0, estTokens(diskBytes) - estTokens(prefetch.renderedChars || 0));
    savings += prefetchSaved;
  }

  // Merge the two record lists into true execution order so a read is
  // classified against the KB results that existed *at that moment*.
  const merged = [];
  for (const r of kbCalls || []) merged.push({ ...r, _kb: true });
  for (const r of fallbackCalls || []) merged.push({ ...r, _kb: false });
  const hasSeq = merged.some((r) => typeof r.seq === 'number');
  if (hasSeq) merged.sort((a, b) => a.seq - b.seq);

  for (const rec of merged) {
    if (rec._kb) {
      const { result } = rec;
      if (!result || typeof result !== 'object') continue; // no payload (e.g. failed exec)
      if (isErrorResult(result)) { kbErrors += 1; continue; } // broken, not ignored
      kb += 1;
      for (const p of extractKbResultFilePaths(result)) kbFilePaths.add(p);
      savings += await estimateCallSavings(result, root, estTokens, counted);
    } else {
      const { call, result } = rec;
      if (!call || typeof call.name !== 'string') continue;
      if (call.name === 'read') {
        const args = parseArgs(call);
        const p = args && typeof args.path === 'string' ? args.path : '';
        const cls = classifyRead(p, kbFilePaths, result);
        if (cls === 'kb-assisted') { kbAssistedReads += 1; continue; }
        if (cls === 'targeted') { targetedReads += 1; continue; }
        if (cls === 'cold') { coldReads += 1; fallbacks += 1; continue; }
        continue; // non-source read: neither fallback nor KB
      }
      if (fallbackKind(call)) fallbacks += 1; // bash-search / grep / find / ast_grep
    }
  }

  const denom = kb + fallbacks;
  return {
    kbCalls: kb,
    fallbackCalls: fallbacks,
    hitRate: denom > 0 ? kb / denom : 0,
    estimatedTokensSaved: savings,
    prefetchSaved,
    kbErrors,
    coldReads,
    targetedReads,
    kbAssistedReads,
  };
}

export const _internals = {
  isBashSearch, fallbackKind, classifyRead, extractKbResultFilePaths,
  estimateCallSavings, resultContentBytes, pathsIntersect, isErrorResult,
  clearStatCacheForTests,
};
