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
