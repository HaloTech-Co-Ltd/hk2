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
 * Minimal .gitignore loader.
 *
 * Walks the source root for `.gitignore` files (cascading: a child
 * directory's `.gitignore` overrides the parent's). Compiles each entry to
 * a RegExp that handles the common gitignore subset:
 *   - blank lines and `#` comments are ignored
 *   - leading `!` negates
 *   - `*` (single segment), `?` (single char), `**` (multi-segment)
 *   - trailing `/` (directory-only — approximated here)
 *   - leading `/` (anchored to root)
 *
 * Returns a predicate `(relPath, isDirectory) => boolean`.
 *
 * This is NOT a full git implementation. It targets the 95% case: typical
 * repo .gitignore files like `node_modules/`, `dist/`, `*.log`, `target/`,
 * `__pycache__/`, `.env*`. Edge cases (character classes, nested negation
 * chains) are intentionally out of scope.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fs_atomic.js';

/**
 * Load all `.gitignore` files under `sourceRoot` and return a predicate.
 *
 * @param {string} sourceRoot
 * @returns {Promise<(relPath: string, isDir?: boolean) => boolean>}
 */
export async function loadGitignore(sourceRoot) {
  if (!sourceRoot || !await exists(sourceRoot)) return () => false;
  const rules = [];   // [{ re, negate, dirOnly, depth }]

  await scanDir(sourceRoot, '', rules, 0);

  return function isIgnored(relPath, isDir = false) {
    if (!relPath) return false;
    const norm = relPath.split(path.sep).join('/');
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !norm.endsWith('/')) {
        // dir-only rule still matches if relPath contains a matching segment
        const parts = norm.split('/');
        const hit = parts.slice(0, -1).some(p => r.re.test(p + '/'));
        if (!hit) continue;
      }
      if (r.re.test(norm) || r.re.test(norm + '/')) {
        ignored = !r.negate;
      }
    }
    return ignored;
  };

  async function scanDir(absRoot, relDir, rules, depth) {
    if (depth > 6) return;   // bound the walk
    const dirAbs = relDir ? path.join(absRoot, relDir) : absRoot;
    let entries;
    try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); }
    catch { return; }

    // Load .gitignore in this dir if present
    const gi = entries.find(e => e.isFile() && e.name === '.gitignore');
    if (gi) {
      const full = path.join(dirAbs, '.gitignore');
      try {
        const src = await fs.readFile(full, 'utf8');
        for (const rule of parseGitignore(src)) {
          rules.push({
            re: compilePattern(rule.pattern, !!rule.leadingSlash),
            negate: rule.negate,
            dirOnly: rule.dirOnly,
            depth,
            baseDir: relDir,
          });
        }
      } catch { /* ignore */ }
    }

    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      if (ent.isDirectory()) {
        const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        await scanDir(absRoot, childRel, rules, depth + 1);
      }
    }
  }
}

/**
 * Parse a .gitignore file into an array of rules.
 * Each rule: { pattern, negate, dirOnly, leadingSlash }
 */
function parseGitignore(src) {
  const out = [];
  for (const rawLine of src.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    // Trim trailing spaces unless escaped
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/') && line.length > 1) { dirOnly = true; line = line.slice(0, -1); }
    let leadingSlash = false;
    if (line.startsWith('/')) { leadingSlash = true; line = line.slice(1); }
    out.push({ pattern: line, negate, dirOnly, leadingSlash });
  }
  return out;
}

/**
 * Compile a gitignore pattern into a RegExp.
 * Honours `*`, `**`, `?`, leading `/` (anchored).
 */
function compilePattern(pattern, leadingSlash) {
  let re = leadingSlash ? '^' : '(?:^|/)';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') { re += '(?:.*/)?'; i++; }
        else re += '.*';
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '\\' && pattern[i + 1]) {
      re += escapeRegex(pattern[i + 1]);
      i += 2;
    } else if ('.+()|^$\\{}[]'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '(?:$|/)';
  return new RegExp(re);
}

function escapeRegex(c) {
  return '.+()|^$\\{}[]'.includes(c) ? '\\' + c : c;
}
