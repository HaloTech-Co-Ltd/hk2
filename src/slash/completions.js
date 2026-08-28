/*-------------------------------------------------------------------------*/

/**
 * Dynamic (data-dependent) slash completion sources.
 *
 * slashCompletions() in index.js is a SYNCHRONOUS pure function over the
 * static registry (SLASH_COMMANDS + HELP_TEXT). Real argument positions,
 * however, need live data: /model use|set|del|... wants the configured
 * provider/id refs, /session resume wants the project's stored session
 * ids, /project set current|drop wants registered projects. This module
 * owns everything async about that:
 *
 *   - dynamicSlot(tokens)          WHERE in the token stream a dynamic
 *                                  argument sits (pure, no IO) — exported
 *                                  for tests and for the static phase enum
 *                                  handling in index.js.
 *   - dynamicContextKey(line)      WHICH data kind the line's cursor token
 *                                  needs ('models' | 'sessions' |
 *                                  'projects'), or null when the static
 *                                  machinery suffices.
 *   - fetchDynamicItems(kind, ...) loads that kind (short TTL cache, keyed
 *                                  per project for sessions) and returns a
 *                                  plain snapshot; failures degrade to []
 *                                  so a completion menu NEVER throws.
 *   - currentDynamicSnapshot()     the most recent cached values of every
 *                                  kind — the TUI passes this into its
 *                                  synchronous per-keypress render.
 *
 * The sync/async split is deliberate: the TUI menu renders on EVERY
 * keypress (must stay sync), so it renders from the snapshot and a
 * fire-and-forget refreshDynamic() call re-renders once fresh data lands.
 * The REPL completer runs only on Tab and can simply await.
 */
import { loadModels, loadProjects, SESSIONS_ROOT } from '../../lib/config/home.js';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Cache lifetime: interactive typing cadence — 1.5s keeps Tab spam off the disk. */
const DYN_TTL_MS = 1500;

/** @type {Map<string, {at: number, items: any}>} cacheKey → snapshot */
const cache = new Map();

/**
 * Map a tokenized line to the dynamic argument slot it is currently at.
 *
 * `tokens` follows slashCompletions' convention: tokens = line.split(/\s+/)
 * — the LAST token is the (possibly empty) fragment being completed.
 *
 * @returns {{kind: 'models'|'sessions'|'projects', index: number} | null}
 */
export function dynamicSlot(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return null;
  const family = tokens[0];
  const frag = tokens[tokens.length - 1];
  const isFlagPos = typeof frag === 'string' && frag.startsWith('--');
  const last = tokens.length - 1;

  if (family === '/model') {
    const sub = tokens[1];
    // <ref> is the sole positional for these subs; flags may follow, but a
    // flag token is never the ref itself.
    if (sub === 'use' || sub === 'del' || sub === 'add-mcpserver') {
      return (!isFlagPos && last === 2) ? { kind: 'models', index: 2 } : null;
    }
    if (sub === 'set') {
      return (!isFlagPos && last === 2) ? { kind: 'models', index: 2 } : null;
    }
    if (sub === 'set-default') {
      // /model set-default <ref> | /model set-default current <ref>
      if (last === 2 && !isFlagPos) return { kind: 'models', index: 2 };
      if (tokens[2] === 'current' && last === 3 && !isFlagPos) return { kind: 'models', index: 3 };
      return null;
    }
    if (sub === 'set-phase') {
      // First positional (non-flag) token at index>=2 is the ref. The last
      // token is the ref slot when it IS that first positional.
      let refIdx = -1;
      for (let i = 2; i <= last; i++) {
        if (!tokens[i].startsWith('--')) { refIdx = i; break; }
      }
      if (!isFlagPos && refIdx === last) return { kind: 'models', index: last };
      return null;
    }
    return null;
  }
  if (family === '/session') {
    const sub = tokens[1];
    if ((sub === 'resume' || sub === 'info') && last === 2) return { kind: 'sessions', index: 2 };
    return null;
  }
  if (family === '/resume') {
    // /resume <id> — no subcommands, so the 2nd token IS the session id.
    return last === 1 ? { kind: 'sessions', index: 1 } : null;
  }
  if (family === '/project') {
    const sub = tokens[1];
    if ((sub === 'drop' || sub === 'rm') && last === 2) return { kind: 'projects', index: 2 };
    if (sub === 'set' && tokens[2] === 'current' && last === 3) return { kind: 'projects', index: 3 };
    return null;
  }
  return null;
}

/**
 * Which dynamic data kind does this line's cursor position need?
 * @returns {'models'|'sessions'|'projects'|null}
 */
export function dynamicContextKey(line) {
  if (typeof line !== 'string' || !line.startsWith('/')) return null;
  const tokens = line.split(/\s+/);
  const slot = dynamicSlot(tokens);
  return slot ? slot.kind : null;
}

/* ---------------------------------------------------------------- */
/* Loaders                                                          */
/* ---------------------------------------------------------------- */

/** Flatten models.json into provider/id refs with a short description. */
async function loadModelRefs() {
  const { providers } = await loadModels();
  const out = [];
  for (const [prov, p] of Object.entries(providers || {})) {
    if (!p || typeof p !== 'object') continue;
    for (const m of p.models || []) {
      const desc = [
        typeof m.name === 'string' && m.name !== m.id ? m.name : '',
        typeof p.api === 'string' ? p.api : '',
        Number.isFinite(m.contextWindow) ? `ctx ${m.contextWindow}` : '',
      ].filter(Boolean).join(' · ');
      out.push({ ref: `${prov}/${m.id}`, desc });
    }
  }
  return out;
}

/**
 * Newest-first session list for a project (ids + mtime/size description).
 * Reads only the directory listing + stat — no transcript parsing, so the
 * menu cost is one readdir even for long histories.
 */
async function loadSessionIds(projectId) {
  if (!projectId) return [];
  const dir = path.join(SESSIONS_ROOT, projectId);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return []; // no sessions yet (or unreadable) — empty, never an error
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.endsWith('.jsonl')) continue;
    const p = path.join(dir, ent);
    const st = await fsp.stat(p).catch(() => null);
    if (!st) continue;
    const dt = new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
    out.push({ id: ent.replace(/\.jsonl$/, ''), desc: `${dt} · ${(st.size / 1024).toFixed(1)}KB`, mtime: st.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 20);
}

/** Registered projects for /project set current|drop. */
async function loadProjectList() {
  const { projects } = await loadProjects();
  return Object.values(projects || {}).map((p) => {
    // Prefer the human name when it is token-safe (no spaces — a completion
    // label is a single token); otherwise fall back to the internal id.
    const token = (typeof p.name === 'string' && p.name && !/\s/.test(p.name)) ? p.name : p.id;
    return { ref: token, id: p.id, desc: p.sourcePath || '' };
  });
}

const LOADERS = {
  models: loadModelRefs,
  sessions: ({ projectId } = {}) => loadSessionIds(projectId),
  projects: loadProjectList,
};

/**
 * Fetch a dynamic data kind through the TTL cache. Never throws: any
 * loader failure degrades to [] so completion stays best-effort.
 *
 * @param {'models'|'sessions'|'projects'} kind
 * @param {{projectId?: string}} [opts]
 */
export async function fetchDynamicItems(kind, { projectId } = {}) {
  const loader = LOADERS[kind];
  if (!loader) return [];
  const ck = `${kind}:${projectId || ''}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < DYN_TTL_MS) return hit.items;
  let items;
  try {
    items = await loader({ projectId });
  } catch {
    items = [];
  }
  cache.set(ck, { at: Date.now(), items });
  return items;
}

/**
 * Drop cached entries (all, or one kind). Call after a command mutates the
 * underlying store so the very next Tab sees fresh data instead of waiting
 * out the TTL.
 */
export function invalidateDynamicCache(kind) {
  if (!kind) { cache.clear(); return; }
  for (const k of [...cache.keys()]) {
    if (k === kind || k.startsWith(`${kind}:`)) cache.delete(k);
  }
}

/**
 * Latest snapshot of every cached kind, shaped for slashCompletions' `dyn`
 * parameter. The TUI renders synchronously from this between refreshes.
 */
export function currentDynamicSnapshot() {
  const snap = {};
  for (const [k, v] of cache.entries()) {
    const kind = k.split(':')[0];
    snap[kind] = v.items;
  }
  return snap;
}
