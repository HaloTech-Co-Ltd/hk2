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
