/**
 * AST dispatcher — picks Tree-sitter when available, else falls back to the
 * regex-based parsers (c_parser / ylex_parser / generic_parser).
 *
 * Behaviour:
 *   - First call probes `import('tree-sitter')` and memoises the result.
 *   - For each invocation, if tree-sitter is ready and a grammar exists for
 *     the file extension, the source is parsed by ts_parser.
 *   - If tree-sitter is unavailable, or the grammar fails to load, or the
 *     parse returns null, fall back to the legacy regex parsers.
 *
 * The Symbol[] shape returned is the union of the existing fields plus the
 * new optional fields (qualName, parentSymbolId, superClass, implements,
 * imports, docString) which legacy parsers leave undefined.
 */

import { parseCSource } from './c_parser.js';
import { parseYlexSource } from './ylex_parser.js';
import { parseGenericSource } from './generic_parser.js';
import { parseWithTreeSitter, isTreeSitterReady, LANG_BY_EXT } from './ts_parser.js';
import log from '../util/log.js';

let _probed = false;
let _tsReady = false;

// Extension → language key understood by lib/parser/generic_parser.js
const GENERIC_LANG_BY_EXT = {
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', kts: 'kotlin', scala: 'scala',
  rb: 'ruby', php: 'php', swift: 'swift',
  sh: 'shell', bash: 'shell', zsh: 'shell',
};

async function probe() {
  if (_probed) return _tsReady;
  _tsReady = await isTreeSitterReady();
  _probed = true;
  if (_tsReady) {
    log.info('AST dispatcher: tree-sitter is available; using AST parsers');
  } else {
    log.warn('AST dispatcher: tree-sitter not available; using regex-based parsers (run `npm install`)');
  }
  return _tsReady;
}

/**
 * Parse a source file by extension. Returns Symbol[] (possibly empty).
 *
 * @param {string} src          source text
 * @param {string} ext          file extension (no leading dot), e.g. 'py', 'ts'
 * @param {number} fileId
 * @returns {Promise<Array>}
 */
export async function parseSource(src, ext, fileId) {
  if (!ext) return [];

  // Try tree-sitter first
  if (await probe()) {
    if (LANG_BY_EXT[ext]) {
      try {
        const out = await parseWithTreeSitter(src, ext, fileId);
        if (out && out.length >= 0) return out;
      } catch (err) {
        log.warn('tree-sitter parse failed; falling back to regex', { ext, msg: err.message });
      }
    }
  }

  // Legacy fallback path. c_parser and ylex_parser return { symbols, generated };
  // unwrap to the symbols array so callers get a consistent Array<Symbol> shape
  // (generic_parser and ts_parser already return arrays directly).
  if (ext === 'c' || ext === 'h') return (parseCSource(src, { fileId })?.symbols) || [];
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'hpp') return (parseCSource(src, { fileId })?.symbols) || [];
  if (ext === 'y' || ext === 'l') return (parseYlexSource(src, { fileId })?.symbols) || [];
  return parseGenericSource(src, { fileId, language: GENERIC_LANG_BY_EXT[ext] });
}

/**
 * Sync probe (returns cached value, or null if not yet probed).
 * Useful for status reporting.
 */
export function getParserMode() {
  if (!_probed) return 'unknown';
  return _tsReady ? 'ast' : 'regex';
}
