/**
 * Filesystem permission system driven by setting.json.
 *
 * Model (mirrors Unix rwx, applied to the agent's file tools):
 *   - r : read file content / list directory
 *   - w : create / modify / delete files, create entries inside a directory
 *   - x : execute (bash commands touching the path, run scripts)
 *
 * Decision order for a target path P and access mode m ∈ {r,w,x}:
 *   1. Longest-prefix rule from setting.json wins (allow OR deny). Project
 *      setting.json rules overlay global ~/.hk2/setting.json rules; the
 *      project file is authoritative on ties (same prefix length).
 *   2. Otherwise, if P is inside the current project → default ALLOW with
 *      file=rw / dir=rwx (dir "w" also grants file w inside; dir "r"
 *      grants listing).
 *   3. Otherwise (outside the project, no rule) → DENY, always.
 *
 * setting.json format (both global ~/.hk2/setting.json and project-root
 * setting.json):
 *   {
 *     "permissions": [
 *       { "path": "/absolute/path", "allow": "rwx" },   // allow subset
 *       { "path": "/absolute/path", "deny": "rwx" }     // deny subset
 *   }
 *
 * Relative paths inside a project setting.json resolve against the project
 * root (the directory containing that setting.json). Every rule applies to
 * its target path AND everything below it (directory semantics); a trailing
 * "/**" is accepted but has no additional effect.
 *
 * Merge semantics: project rules are appended after global rules; on the same
 * target path the project file wins (later, more specific layer replaces the
 * earlier one). Deny entries always beat allow entries of equal or shorter
 * prefix.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readJsonSafe } from '../util/fs_atomic.js';
import { log } from '../util/log.js';

export const RWX = { read: 'r', write: 'w', exec: 'x' };
const VALID_MODES = new Set(['r', 'w', 'x']);

/** Directory(s) that scope "inside project" defaults: cwd + HK2_PROJECT_SOURCE. */
export function getDefaultRoots() {
  const roots = [process.cwd()];
  if (process.env.HK2_PROJECT_SOURCE) roots.push(process.env.HK2_PROJECT_SOURCE);
  return [...new Set(roots.map(r => path.resolve(r)))];
}

/** Primary project root (the one rules resolve against). */
export function getProjectRoot() {
  return path.resolve(process.env.HK2_PROJECT_SOURCE || process.cwd());
}

function hk2Home() {
  return path.resolve(process.env.HK2_HOME || path.join(os.homedir(), '.hk2'));
}

function normalizeModeSet(raw, field) {
  const s = new Set();
  const str = String(raw || '');
  for (const ch of str) {
    if (!VALID_MODES.has(ch)) {
      throw new Error(`setting.json: invalid permission char "${ch}" in "${field}" (expected subset of rwx)`);
    }
    s.add(ch);
  }
  return s;
}

/**
 * Parse a raw permissions array into normalized rules. Per-entry parse
 * failures (e.g. an invalid mode char) are pushed onto `errors` and only the
 * offending entry is dropped — the rest of the layer keeps working
 * (deny-by-default for the dropped paths, everything else unchanged).
 */
export function normalizeRules(raw, { baseDir, errors = [] } = {}) {
  const rules = [];
  if (!Array.isArray(raw)) return rules;
  for (const entry of raw) {
    try {
      if (!entry || typeof entry !== 'object') {
        errors.push(`entry ${JSON.stringify(entry)} skipped: not an object`);
        continue;
      }
      const rawPath = entry.path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        errors.push(`entry ${JSON.stringify(entry)} skipped: missing/empty "path"`);
        continue;
      }
      let recursive = false;
      let p = rawPath.trim();
      if (p.endsWith('/**')) { recursive = true; p = p.slice(0, -3); }
      // Expand a leading ~ to the user home (documented in README; matches
      // extractCommandPaths, which already expands ~ in scanned commands).
      if (p === '~') p = os.homedir();
      else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
      let abs;
      if (path.isAbsolute(p)) {
        abs = path.resolve(p);
      } else {
        abs = path.resolve(baseDir || process.cwd(), p);
      }
      const hasAllow = entry.allow !== undefined;
      const hasDeny = entry.deny !== undefined;
      // Both fields present is ambiguous (silently picking one would let the
      // user believe a restriction is active when it is not) — surface it.
      if (hasAllow && hasDeny) {
        errors.push(`entry "${p}" skipped: has BOTH "allow" and "deny" — provide exactly one`);
        continue;
      }
      if (!hasAllow && !hasDeny) {
        errors.push(`entry "${p}" skipped: missing "allow" or "deny" field (check spelling, e.g. "alow")`);
        continue;
      }
      const field = hasAllow ? 'allow' : 'deny';
      rules.push({
        abs,
        recursive,
        effect: field,
        modes: normalizeModeSet(entry[field], field),
        source: entry.source || null,
      });
    } catch (err) {
      errors.push(`entry ${JSON.stringify(entry?.path ?? entry)} skipped: ${err.message}`);
    }
  }
  return rules;
}

/** Longest-prefix match: a rule covers the target itself and EVERYTHING
 * below it (filesystem dir-permission semantics: granting r on a directory
 * means reading files inside it). A rule on a plain file matches only that
 * file naturally — files have no children. Matches against BOTH the lexical
 * target and (when known) the symlink-resolved one, so a rule written as
 * /tmp/x still matches /private/tmp/x/file on symlinked-root systems. */
function ruleMatches(rule, target) {
  // A rule on the filesystem root ("/" or "C:\") covers every absolute
  // target; the plain prefix concat below would produce "//" and never
  // match anything.
  if (rule.abs === path.parse(target).root) return true;
  if (target === rule.abs || target.startsWith(rule.abs + path.sep)) return true;
  const real = rule.realAbs;
  if (real && real !== rule.abs && (target === real || target.startsWith(real + path.sep))) return true;
  return false;
}

const LAYER_PRIORITY = { global: 1, project: 2 };

/**
 * Compute the applicable mode set for a target path.
 * Walks all rules and keeps:
 *   1. the longest matching prefix;
 *   2. on equal prefix — the project layer beats the global layer (the
 *      project-local setting.json is a deliberate override of the baseline);
 *   3. within the same layer — deny beats allow (safety-first).
 * Returns { modes:Set, matchedRule }.
 */
export function resolveModes(rules, target) {
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, target)) continue;
    if (!best) { best = rule; continue; }
    const lenDiff = rule.abs.length - best.abs.length;
    if (lenDiff > 0) { best = rule; continue; }
    if (lenDiff < 0) continue;
    // equal prefix length: layer first, then deny>allow
    const lp = (LAYER_PRIORITY[rule.source] || 0) - (LAYER_PRIORITY[best.source] || 0);
    if (lp > 0) { best = rule; continue; }
    if (lp < 0) continue;
    if (rule.effect === 'deny' && best.effect === 'allow') best = rule;
  }
  if (!best) return { modes: new Set(), matchedRule: null };
  return { modes: best.modes, matchedRule: best };
}

/**
 * Load and merge global + project setting.json permission rules.
 * Returns { rules, errors } — per-file / per-rule parse failures are caught
 * and collected into errors (also logged once at load time); only the
 * offending rule is dropped, so a bad entry degrades to deny-by-default
 * instead of rejecting every subsequent permission check.
 */
export async function loadPermissionRules({ projectRoot } = {}) {
  const root = path.resolve(projectRoot || getProjectRoot());
  const errors = [];
  const rules = [];

  const files = [
    { fp: path.join(hk2Home(), 'setting.json'), baseDir: root, layer: 'global' },
    { fp: path.join(root, 'setting.json'), baseDir: root, layer: 'project' },
  ];

  for (const { fp, baseDir, layer } of files) {
    const raw = await readJsonSafe(fp, null);
    if (!raw || typeof raw !== 'object') continue;
    const layerErrors = [];
    const layerRules = normalizeRules(raw.permissions, { baseDir, errors: layerErrors });
    for (const e of layerErrors) errors.push(`setting.json (${layer}): ${e}`);
    for (const e of layerRules) e.source = layer;
    rules.push(...layerRules);
    // No aggregate "no valid entries" warning: every dropped entry now
    // produces its own explicit error above (invalid mode char, missing /
    // ambiguous allow+deny, non-object, ...), and an EMPTY permissions
    // array is a legitimate "no rules" config that must not warn.
  }

  // Canonicalize every rule target (resolve symlinks) so a rule written
  // against a lexical path (e.g. /tmp/x) also matches the real path of the
  // scanned target (e.g. /private/tmp/x/f) on symlinked-root systems. This
  // mirrors the realpath re-check in PermissionService.checkReal and keeps
  // allow rules USEFUL (not just deny rules strict) under indirection.
  await Promise.all(rules.map(async (r) => {
    try { r.realAbs = await fs.realpath(r.abs); } catch { r.realAbs = null; }
  }));

  // Surface load problems once so users notice their config is partly
  // ignored (checks still resolve; the affected paths stay deny-by-default).
  for (const e of errors) log.warn('permission-config', e);

  return { rules, errors };
}

/** Is target inside (or equal to) any default root (cwd / project source)?
 * `rootsOverride` (used by checkPermissionReal) supplies pre-canonicalized
 * roots so symlink-aware checks stay consistent with the lexical ones. */
export function isInsideProject(target, projectRoot = null, rootsOverride = null) {
  const t = path.resolve(target);
  const roots = rootsOverride || (projectRoot ? [path.resolve(projectRoot)] : getDefaultRoots());
  return roots.some(r => t === r || t.startsWith(r + path.sep));
}

/**
 * Compact summary of the currently effective permission model, meant for
 * injection into the agent's system prompt so the model knows the sandbox up
 * front instead of discovering it through "permission denied" errors.
 * Keeps to a handful of short lines — prompt budget matters more than detail
 * here; enforcement is unaffected.
 * @returns {{ text: string, roots: string[], rules: Array }}
 */
export function summarizePermissionsForPrompt({ rules, roots } = {}) {
  const rootList = roots || getDefaultRoots();
  const list = Array.isArray(rules) ? rules : [];
  const lines = [];
  lines.push(`- Workspace roots — everything at/under them is ALLOWED (rwx): ${rootList.join(', ')}`);
  if (list.length === 0) {
    lines.push('- No extra setting.json rules. Anything OUTSIDE the roots above is DENIED.');
    return { text: lines.join('\n'), roots: rootList, rules: list };
  }
  lines.push('- setting.json rules (longest-prefix wins; a rule covers its path AND everything beneath it; a matching rule fully decides r/w/x):');
  for (const r of list) {
    const modes = ['r', 'w', 'x'].filter(m => r.modes?.has(m)).join('') || '(none)';
    lines.push(`    - ${r.effect} ${modes}: ${r.abs}${r.recursive ? '/**' : ''} [${r.source}]`);
  }
  return { text: lines.join('\n'), roots: rootList, rules: list };
}

/**
 * Build the prompt summary from the SAME singleton the tools enforce with
 * (so the prompt never claims permissions the sandbox doesn't actually
 * grant). Never throws — on failure returns null and the prompt section is
 * simply omitted.
 */
export async function buildPermissionPromptSummary() {
  try {
    const svc = getPermissionService();
    const rules = await svc.ensureLoaded();
    return summarizePermissionsForPrompt({ rules });
  } catch (err) {
    log.warn('permission-config', `prompt summary failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a KB-indexed filePath (project-relative or absolute) to its
 * on-disk absolute-path candidates, in root-precedence order: an absolute
 * path resolves to itself; a relative one resolves against
 * HK2_PROJECT_SOURCE first, then cwd (the same roots loadSlices reads
 * through). Shared by the KB tools (tools.js) and the per-turn context
 * builder (graph.js) so permission checks see exactly the paths that would
 * actually be read.
 */
export function kbPathCandidates(p) {
  if (typeof p !== 'string' || !p) return [];
  if (path.isAbsolute(p)) return [path.resolve(p)];
  const bases = process.env.HK2_PROJECT_SOURCE
    ? [process.env.HK2_PROJECT_SOURCE, process.cwd()]
    : [process.cwd()];
  return [...new Set(bases.map(b => path.resolve(b, p)))];
}

/**
 * Resolve a KB-indexed filePath to THE single on-disk file that actually
 * carries its content: the first root candidate that EXISTS (absolute
 * paths resolve to themselves when present). When no candidate exists
 * (indexed file deleted after indexing, or the index root differs from
 * the permission roots), fall back to the FIRST candidate — the lexical
 * project-source spelling — so checkPermission still evaluates the path
 * the index claims (deny rules on a deleted subtree keep suppressing its
 * mirrored content). Permission decisions for KB content MUST go through
 * this — checking each candidate independently and allowing on ANY hit
 * would leak a denied <project>/x via a non-existent cwd/x whose nearest
 * existing ancestor (cwd) is inside the workspace.
 */
export async function resolveKbContentPath(p) {
  const candidates = kbPathCandidates(p);
  for (const abs of candidates) {
    try { await fs.stat(abs); return abs; }
    catch { /* try next candidate */ }
  }
  return candidates[0] ?? null;
}

/** Batch form of resolveKbContentPath: Map<originalPath, abs|null>. */
export async function resolveKbContentPaths(paths) {
  const uniq = [...new Set((paths || []).filter(p => typeof p === 'string' && p))];
  const out = new Map();
  await Promise.all(uniq.map(async (p) => {
    out.set(p, await resolveKbContentPath(p));
  }));
  return out;
}

/**
 * Batch permission filter: given ABSOLUTE paths, return the subset that is
 * readable ('r' via checkReal — lexical decision + symlink-resolved
 * re-check). KB snapshots (symbol bodies → snippets, doc strings) and disk
 * slices carry real file content; callers use this so a deny rule in
 * setting.json suppresses those rows exactly as it suppresses a read().
 */
export async function filterAllowedPaths(absPaths) {
  const uniq = [...new Set((absPaths || []).filter(Boolean).map(p => path.resolve(p)))];
  if (uniq.length === 0) return new Set();
  const svc = getPermissionService();
  const allowed = new Set();
  await Promise.all(uniq.map(async (abs) => {
    try {
      const res = await svc.checkReal(abs, 'r');
      if (res.ok) allowed.add(abs);
    } catch { /* unreadable/unknown → treat as denied */ }
  }));
  return allowed;
}

/* ------------------------------------------------------------------ */
/* bash command scanning (best-effort, documented as non-hard-guarantee)*/
/* ------------------------------------------------------------------ */

/**
 * Extract absolute or cwd-relative-candidate paths from a shell command.
 * Best-effort: catches explicit absolute paths (/...), obvious
 * relative-with-.. segments, and slash-bearing relative operands resolved
 * against the command's effective base directory (tracked through cd
 * sequences — last cd wins). Bare relative names (no slash, no ..) are NOT
 * extracted — they resolve against cwd which is always a workspace root.
 */
export function extractCommandPaths(command, { baseDir } = {}) {
  const out = new Set();
  if (!command || typeof command !== 'string') return [...out];
  // Strip URLs first so https://host/path doesn't leak a bogus path match.
  const cleaned = command.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`]+/g, ' ');
  // Effective base directory for relative operands. `cd <dir> && cat x/y`
  // changes where a relative path lands; tracking the last cd target
  // approximates where later operands resolve.
  const initialBase = path.resolve(baseDir || process.cwd());
  let base = initialBase;
  // Absolute paths: /usr/local/bin/node, ~/work/x, /tmp/x. The '/' form
  // must start at a TOKEN boundary (string start or after whitespace/quote/
  // '='/'('/'{'/','/';'), otherwise mid-token slashes in patterns like
  // 'grep lib/config .', "sed 's/a/b/'" or 'date +%Y/%m/%d' would be
  // mistaken for absolute paths (/config, /b, /m/%d) and falsely deny the
  // whole command. Lookbehind asserts the preceding char without consuming
  // it, so the capture starts exactly at the path's first character.
  const absRe = /(?<=^|[\s'"`=(,;{])((?:~\/|[.]{1,2}\/)?(?:\/|[a-zA-Z]:\\)[^\s'"`;&|<>()[\]{}$]+)/g;
  for (const m of cleaned.matchAll(absRe)) {
    out.add(m[1].replace(/^~/, os.homedir()));
  }
  // Relative paths containing .. segments: ../foo, ../../etc/passwd
  const relRe = /(?:^|[\s'"`(=;|&])((?:\.\.\/)+[^\s'"`;&|<>()[\]{}$]*)/g;
  for (const m of cleaned.matchAll(relRe)) {
    out.add(path.resolve(base, m[1]));
  }
  // Slash-bearing relative operands (secrets/key.js, src/lib/x.ts). These
  // resolve against the command's base directory — previously skipped
  // entirely, which let `cat secrets/key.js` bypass a deny rule on the
  // secrets directory. Filters out non-path tokens: option flags (--foo,
  // -f — via the (?!-) lookahead), format specifiers (date +%Y/%m/%d — %
  // excluded), sed programs (s/a/b/ — single-letter head segment + trailing
  // slash), and ./ ../ forms (already covered by absRe/relRe).
  const slashRe = /(^|[\s'"`=(,;{&|])(?!-([^\s'"`;&|<>()[\]{}$%~]*\/))([^\s'"`;&|<>()[\]{}$%~]+\/[^\s'"`;&|<>()[\]{}$%~]+)/g;
  const addSlashTok = (tok) => {
    const segs = tok.split('/');
    if (segs.length >= 3 && segs[0].length === 1 && tok.endsWith('/')) return; // sed s/a/b/
    if (tok.startsWith('./') || tok.startsWith('../')) return; // covered above
    out.add(path.resolve(base, tok));
  };
  for (const m of cleaned.matchAll(slashRe)) {
    addSlashTok(m[3]);
  }
  // cd tracking: if the command cds somewhere, re-resolve the slash-bearing
  // operands against the final base too (approximation — applies the last
  // cd uniformly to slash tokens; absRe/relRe captures before it keep their
  // resolution, which is correct for operands that appear BEFORE the cd).
  const cdRe = /(?:^|[;&|]\s*|&&\s*|\|\|\s*)cd\s+([^\s;&|<>()[\]{}'"`]+)/g;
  const cdMatches = [...cleaned.matchAll(cdRe)];
  if (cdMatches.length > 0) {
    const last = cdMatches[cdMatches.length - 1][1].replace(/^~/, os.homedir());
    base = path.isAbsolute(last) ? path.resolve(last) : path.resolve(initialBase, last);
    for (const m of cleaned.matchAll(slashRe)) {
      addSlashTok(m[3]);
    }
  }
  // Redirect targets — including forms glued to the operator or the
  // preceding word (`2>/path`, `>>/path`, `&>/path`, `echo hi>/path`).
  // absRe's lookbehind cannot start a match right after '>' (it is not in
  // the boundary class), so without this pass the no-space forms would
  // escape scanning entirely. Only path-shaped targets are kept: bare
  // relative names resolve against cwd (always a workspace root), and
  // fd-dup operands like `2>&1` contain no path at all.
  const redirRe = /(?:\d+|&)?>>?\s*([~./][^\s;&|<>(){}'"`]*)/g;
  for (const m of cleaned.matchAll(redirRe)) {
    out.add(m[1].replace(/^~(?=\/|$)/, os.homedir()));
  }
  // The platform devnull sink is always writable — it is a data sink, not
  // a real file, and `2>/dev/null` is ubiquitous in benign commands.
  // (Node's os module does NOT export devnull; derive it per platform.)
  const devnull = path.resolve(process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null');
  return [...out].filter(p => p !== devnull);
}

/**
 * Extract the "executed targets" of a shell command — paths that will be
 * run as programs/scripts rather than used as data. Two shapes:
 *   - interpreter invocation: `bash script.sh`, `node x.js`, `python3 a.py`
 *     (the interpreter resolves from PATH; the operand is the target);
 *   - directly invoked absolute/~/-style path as the command itself:
 *     `/tmp/build.sh arg`.
 * Bare relative operands with no slash (e.g. `node server`) are skipped:
 * they cannot be resolved to a permission-relevant absolute path without a
 * filesystem lookup.
 */
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'node', 'deno', 'bun',
  'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'Rscript', 'ts-node']);

function extractExecTargets(command, { baseDir } = {}) {
  const out = new Set();
  if (!command || typeof command !== 'string') return [...out];
  const cleaned = command.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"`]+/g, ' ');
  const base = path.resolve(baseDir || process.cwd());
  // Tokenize on whitespace and shell separators, keeping quotes out of the
  // token text.
  const tokens = cleaned.split(/[\s;&|<>()`]+/).filter(Boolean).map(t => t.replace(/^['"]+|['"]+$/g, ''));
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const bare = tok.replace(/^~/, os.homedir());
    // Direct invocation: token IS an absolute path (command position or
    // after a separator — approximation: any token that is an absolute
    // path is a potential direct invocation; operands after interpreters
    // are handled below, other absolute-path tokens are data paths).
    if (path.isAbsolute(bare)) {
      // treat as executed only when it appears in command position (first
      // token, or right after a separator). We approximate "command
      // position" by index: token 0, or the token following one of the
      // separators we split on is impossible to know post-split, so we
      // conservatively accept token 0 plus interpreter operands below.
      if (i === 0) out.add(bare);
      continue;
    }
    // Interpreter invocation: next non-flag token is the script target.
    if (INTERPRETERS.has(tok)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const op = tokens[j];
        if (op.startsWith('-')) continue; // flags like -e, --version
        if (INTERPRETERS.has(op)) continue; // chained shebangs (bash -c like)
        if (op === '-c') continue;
        const opAbs = op.replace(/^~/, os.homedir());
        if (path.isAbsolute(opAbs)) out.add(path.resolve(opAbs));
        else if (op.includes('/')) out.add(path.resolve(base, op));
        break; // only the first non-flag operand is the script
      }
    }
  }
  return [...out];
}

/**
 * Check every path mentioned in a bash command against the permission rules.
 * Three requirement classes:
 *   - executed targets (interpreter operands / directly invoked binaries)
 *     need 'x' — the requirement's execute bit;
 *   - data operands of read-only commands need 'r';
 *   - data operands of mutating commands (rm/mv/cp/redirect/…) need 'w'.
 * Best-effort: this cannot be a hard guarantee (shell is Turing-complete),
 * it catches explicit path references to prevent accidental damage.
 */
export function checkCommandPermission(rules, command, { projectRoot, baseDir } = {}) {
  const paths = extractCommandPaths(command, { baseDir });
  const execTargets = new Set(extractExecTargets(command, { baseDir }));
  if (paths.length === 0 && execTargets.size === 0) return { ok: true, reason: 'no explicit paths detected' };

  // Classify: does the command look mutating? (write-class verbs or a
  // redirect/create flag.)
  const mutating = /(^|[\s;&|(])(rm|rmdir|mv|cp|ln|mkdir|touch|tee|chmod|chown|truncate|shred|dd|install|rsync|sed|gawk|awk|perl|python3?|node|npm|npx|pnpm|yarn|git)\b/.test(command)
    || /(^|\s)(>|>>|2>)\s*[^\s&]/.test(command);

  const failures = [];
  // Data operands: r for read-only commands, w for mutating ones.
  for (const p of paths) {
    if (execTargets.has(p)) continue; // handled with 'x' below
    const need = mutating ? 'w' : 'r';
    const res = checkPermission(rules, p, need, { projectRoot });
    if (!res.ok) failures.push(`${p}: needs ${need} — ${res.reason}`);
  }
  // Executed programs/scripts need 'x' on the target itself.
  for (const p of execTargets) {
    const res = checkPermission(rules, p, 'x', { projectRoot });
    if (!res.ok) failures.push(`${p}: needs x (execute) — ${res.reason}`);
  }
  if (failures.length > 0) {
    return { ok: false, reason: `bash command touches path(s) without permission:\n  - ${failures.join('\n  - ')}` };
  }
  return { ok: true, reason: `all ${paths.length + execTargets.size} detected path(s) permitted` };
}

/**
 * Check one access request.
 * @param {string} target  absolute or cwd-relative path
 * @param {'r'|'w'|'x'} mode
 * @returns { ok: boolean, reason: string, matchedRule?: object }
 */
export function checkPermission(rules, target, mode, { projectRoot, canonicalRoots } = {}) {
  if (!VALID_MODES.has(mode)) return { ok: false, reason: `invalid mode: ${mode}` };
  const abs = path.resolve(target);
  void projectRoot; // defaults are computed from getDefaultRoots() below

  const { modes, matchedRule } = resolveModes(rules, abs);

  if (matchedRule) {
    // A matching rule FULLY determines the mode set for this path (like
    // permission bits on a filesystem object): allow:"r" means r-ONLY, deny:"w"
    // means everything except w. No fall-through to inside-project defaults —
    // otherwise an explicit restriction (allow r on a project subdir) would be
    // silently widened back to rw.
    if (matchedRule.effect === 'deny') {
      if (matchedRule.modes.has(mode)) {
        return { ok: false, reason: `denied by setting.json ${matchedRule.source} rule at ${matchedRule.abs} (deny ${[...matchedRule.modes].join('')})`, matchedRule };
      }
      return { ok: true, reason: `allowed: mode ${mode} not in deny set of setting.json ${matchedRule.source} rule at ${matchedRule.abs}`, matchedRule };
    }
    if (matchedRule.modes.has(mode)) {
      return { ok: true, reason: `allowed by setting.json ${matchedRule.source} rule at ${matchedRule.abs} (allow ${[...matchedRule.modes].join('')})`, matchedRule };
    }
    return { ok: false, reason: `denied: setting.json ${matchedRule.source} rule at ${matchedRule.abs} allows only ${[...matchedRule.modes].join('') || '(nothing)'} — requested ${mode}`, matchedRule };
  }

  // Default: inside any workspace root → allow (file=rw / dir=rwx equivalent:
  // we cannot cheaply stat every path, so inside-project paths get rwx by
  // default — "x" for a file means the agent may reference/execute it via bash).
  if (canonicalRoots ? isInsideProject(abs, null, canonicalRoots) : isInsideProject(abs)) {
    return { ok: true, reason: `inside workspace root(s): ${getDefaultRoots().join(', ')}` };
  }

  return { ok: false, reason: `outside workspace root(s) and no setting.json permission covers ${abs} (configure an allow rule in setting.json to grant access)` };
}

/**
 * Permission service: lazily loads rules once per process, exposes sync
 * checks. Call reload() when a setting.json changes on disk.
 */
export class PermissionService {
  constructor(opts = {}) {
    this.projectRoot = path.resolve(opts.projectRoot || getProjectRoot());
    this._rules = opts.rules || null;
    this._errors = opts.errors || [];
    this._loaded = Boolean(opts.rules);
  }

  async ensureLoaded() {
    if (!this._loaded) {
      const { rules, errors } = await loadPermissionRules({ projectRoot: this.projectRoot });
      this._rules = rules;
      this._errors = errors;
      this._loaded = true;
    }
    return this._rules;
  }

  async reload() {
    this._loaded = false;
    return this.ensureLoaded();
  }

  /** Async check — loads rules on first use. */
  async check(target, mode) {
    await this.ensureLoaded();
    return checkPermission(this._rules, target, mode, { projectRoot: this.projectRoot });
  }

  /** Async bash-command check — verifies every detected path. */
  async checkCommand(command) {
    await this.ensureLoaded();
    return checkCommandPermission(this._rules, command, { projectRoot: this.projectRoot });
  }

  /** Sync check — requires prior ensureLoaded(). */
  checkSync(target, mode) {
    if (!this._loaded) throw new Error('PermissionService: call ensureLoaded() before checkSync()');
    return checkPermission(this._rules, target, mode, { projectRoot: this.projectRoot });
  }

  /**
   * Symlink-aware check: resolve the REAL path of `target` and, when it
   * differs from the lexical path, re-run the decision against the real
   * path. This closes the "in-project symlink → outside file" escape: the
   * lexical check alone sees an inside-project path and allows, while the
   * actual read/write follows the link to an unrestricted location.
   * Non-existent targets fall back to checking the nearest existing
   * ancestor (a write may create the file; the ancestor chain still decides).
   */
  async checkReal(target, mode) {
    const lexical = await this.check(target, mode);
    if (!lexical.ok) return lexical;
    const abs = path.resolve(target);
    let real = null;
    try {
      real = await fs.realpath(abs);
    } catch {
      // Target doesn't exist yet (e.g. write about to create it). Check the
      // nearest existing ancestor instead — same semantics the OS applies
      // when resolving a create through symlinked directories.
      let dir = path.dirname(abs);
      for (let hops = 0; hops < 64; hops++) {
        try {
          const st = await fs.stat(dir);
          if (!st.isDirectory()) dir = path.dirname(dir);
          break;
        } catch {
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      try { real = await fs.realpath(dir); } catch { return lexical; }
    }
    if (!real || real === abs) return lexical;
    // The real path is where the bytes actually land / come from — the rule
    // set must also permit it. Re-run the full decision against the real
    // path, but with CANONICALIZED default roots for the inside-project
    // fallback: on macOS /tmp → /private/tmp indirections the real path of
    // an ordinary in-project file differs from the lexical one, and using
    // lexical roots there would deny everything under a symlinked root.
    const realRes = checkPermission(this._rules, real, mode, { canonicalRoots: await getCanonicalDefaultRoots() });
    if (!realRes.ok) return realRes;
    return lexical;
  }

  get errors() { return this._errors; }
  get rules() { return this._rules; }
}

/**
 * Canonicalize the default workspace roots (resolve symlinks). On macOS
 * /tmp → /private/tmp style indirections mean the REAL path of an
 * inside-project file can differ from the lexical one even without user
 * symlinks; without canonical roots every such file would fail the
 * real-path re-check. checkPermissionReal uses these for its fallback.
 * Memoized per distinct root set (called on every checkReal with a
 * symlinked path — two realpaths each — so caching matters on large walks).
 */
let _canonicalRootsCache = null; // { key: string, roots: string[] }
export async function getCanonicalDefaultRoots() {
  const roots = getDefaultRoots();
  const key = roots.join('|');
  if (_canonicalRootsCache && _canonicalRootsCache.key === key) return _canonicalRootsCache.roots;
  const out = [];
  for (const r of roots) {
    try { out.push(await fs.realpath(r)); } catch { out.push(r); }
  }
  const final = [...new Set(out)];
  _canonicalRootsCache = { key, roots: final };
  return final;
}

/** Singleton shared across all tool calls in this process. */
let _svc = null;
export function getPermissionService() {
  if (!_svc) _svc = new PermissionService();
  return _svc;
}

/** Test helper: drop the cached singleton so the next check re-reads disk. */
export function resetPermissionService() {
  _svc = null;
  _canonicalRootsCache = null;
}
