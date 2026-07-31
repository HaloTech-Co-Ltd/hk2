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
 * Filesystem walker. Glob-based include/exclude, with optional .gitignore
 * filtering and multi-root support (paths stored with their root prefix).
 *
 * Glob syntax: `*` single segment, `**` multi-segment (incl. 0), `?` one
 * char, other chars literal.
 *
 * Hidden directories `.git/`, `.svn/`, `.hg/` are always pruned. Other
 * dotfiles/dot-directories (`.github/`, `.env.example`, etc.) are walked
 * so users can index them via includeGlobs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const PRUNE_DIRS = new Set(['.git', '.svn', '.hg']);

/**
 * Single-root walk.
 */
export async function* walkSource(rootPath, {
  includeGlobs = ['**/*.c', '**/*.h'],
  excludeGlobs = [],
  gitignoreFilter = null,
} = {}) {
  const include = includeGlobs.map(compileGlob);
  const exclude = excludeGlobs.map(compileGlob);
  yield* walk(rootPath, '', include, exclude, '', gitignoreFilter);
}

/**
 * Multi-root walk.
 * @param {Array<{absPath: string, name: string}>} roots
 */
export async function* walkMultiRoot(roots, {
  includeGlobs = ['**/*.c', '**/*.h'],
  excludeGlobs = [],
  gitignoreFilter = null,
} = {}) {
  const include = includeGlobs.map(compileGlob);
  const exclude = excludeGlobs.map(compileGlob);
  for (const r of roots) {
    const prefix = r.name ? (r.name + '/') : '';
    yield* walk(r.absPath, '', include, exclude, prefix, gitignoreFilter);
  }
}

async function* walk(absRoot, relDir, include, exclude, prefix, gi) {
  const dirAbs = path.join(absRoot, relDir);
  let entries;
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    return;
  }
  for (const ent of entries) {
    if (PRUNE_DIRS.has(ent.name)) continue;
    const rel = relDir ? path.join(relDir, ent.name) : ent.name;
    const full = path.join(dirAbs, ent.name);
    const relNorm = rel.split(path.sep).join('/');

    if (ent.isDirectory()) {
      if (gi && gi(relNorm, true)) continue;
      if (exclude.some(re => re.test(relNorm + '/'))) continue;
      yield* walk(absRoot, rel, include, exclude, prefix, gi);
    } else if (ent.isFile()) {
      if (gi && gi(relNorm, false)) continue;
      if (exclude.some(re => re.test(relNorm))) continue;
      if (include.length === 0 || include.some(re => re.test(relNorm))) {
        let stat;
        try { stat = await fs.stat(full); } catch { continue; }
        yield { path: prefix + relNorm, absPath: full, mtimeMs: stat.mtimeMs, size: stat.size };
      }
    }
  }
}

/**
 * Compile a glob pattern into a RegExp.
 * Supports: `**` multi-segment (incl. 0), `*` single-segment, `?` single
 * char, other chars literal.
 */
export function compileGlob(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i+1] === '*') {
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
    } else if ('.+()|^$\\{}[]'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}
