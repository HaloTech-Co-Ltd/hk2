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
