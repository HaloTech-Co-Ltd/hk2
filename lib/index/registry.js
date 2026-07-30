/**
 * KB registration and lifecycle management.
 *
 * Per-project KB lives at ~/.hk2/kb/<projectId>/. The project record in
 * projects.json is the source of truth — there is no separate kb registry.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  kbDir, createKbDir, deleteKb, saveMeta, getMeta, readStats,
} from '../store/kb_store.js';
import { exists } from '../util/fs_atomic.js';

export const PARSER_VERSION = 2;

const DEFAULT_INCLUDE = [
  '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.cxx',
  '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.scala',
  '**/*.rb', '**/*.php', '**/*.swift',
  '**/*.sh', '**/*.bash', '**/*.zsh',
  '**/*.y', '**/*.l',
  // Document globs — parsed by lib/parser/doc_parser.js
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.html', '**/*.htm',
];
const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/target/**',
  '**/.venv/**', '**/vendor/**', '**/__pycache__/**',
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  '**/.idea/**', '**/.vscode/**', '**/.DS_Store',
];

/**
 * Create/overwrite a KB directory and meta.json for a project record.
 *
 * @param {object} project  {id, name, sourcePath, sourceRoot, includeGlobs, excludeGlobs, extraRoots}
 */
export async function addKbForProject(project) {
  if (!project || !project.id) throw new Error('project.id required');
  if (!project.sourcePath) throw new Error('project.sourcePath required');
  const absSource = path.resolve(project.sourcePath);
  if (!await exists(absSource)) throw new Error(`source path not found: ${absSource}`);
  const sourceRoot = project.sourceRoot || '';
  const rootAbs = sourceRoot ? path.join(absSource, sourceRoot) : absSource;
  if (!await exists(rootAbs)) throw new Error(`source root not found: ${rootAbs}`);

  const includeGlobs = project.includeGlobs && project.includeGlobs.length
    ? project.includeGlobs
    : DEFAULT_INCLUDE;
  const excludeGlobs = project.excludeGlobs && project.excludeGlobs.length
    ? project.excludeGlobs
    : DEFAULT_EXCLUDE;

  await createKbDir(project.id);
  const meta = {
    name: project.id,
    projectName: project.name || project.id,
    sourcePath: absSource,
    sourceRoot,
    extraRoots: Array.isArray(project.extraRoots) ? project.extraRoots : [],
    includeGlobs,
    excludeGlobs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    parserVersion: PARSER_VERSION,
  };
  await saveMeta(project.id, meta);
  return meta;
}

/**
 * Legacy addKb: build a KB by name (instead of project record). Used by the
 * `--mode=build-kb` escape hatch when no current project is set (KB name
 * falls back to 'default'). Writes meta.json only — no separate registry.
 *
 * Optional `opts.extra` accepts comma-separated "name:relRoot" entries to
 * register additional source roots under named prefixes.
 */
export async function addKb(name, sourcePath, opts = {}) {
  if (!name) throw new Error('KB name required');
  if (!await exists(sourcePath)) throw new Error(`source path not found: ${sourcePath}`);
  const absSource = path.resolve(sourcePath);
  const sourceRoot = opts.root || '';
  const rootAbs = sourceRoot ? path.join(absSource, sourceRoot) : absSource;
  if (!await exists(rootAbs)) throw new Error(`source root not found: ${rootAbs}`);

  const includeGlobs = opts.include ? String(opts.include).split(',') : DEFAULT_INCLUDE;
  const excludeGlobs = opts.exclude ? String(opts.exclude).split(',') : DEFAULT_EXCLUDE;

  const extraRoots = [];
  if (opts.extra) {
    for (const item of String(opts.extra).split(',')) {
      const colon = item.indexOf(':');
      if (colon > 0) {
        const rname = item.slice(0, colon);
        const relRoot = item.slice(colon + 1);
        const fullRoot = path.join(absSource, relRoot);
        if (await exists(fullRoot)) {
          extraRoots.push({ name: rname, relRoot });
        }
      }
    }
  }

  await createKbDir(name);
  const meta = {
    name,
    sourcePath: absSource,
    sourceRoot,
    extraRoots,
    includeGlobs,
    excludeGlobs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    parserVersion: PARSER_VERSION,
  };
  await saveMeta(name, meta);
  return meta;
}

/**
 * Resolve a stored path (possibly carrying an extra-root prefix) to absolute.
 */
export async function resolveStoredPath(meta, storedPath) {
  for (const r of (meta.extraRoots || [])) {
    const prefix = r.name + '/';
    if (storedPath.startsWith(prefix)) {
      return path.join(meta.sourcePath, r.relRoot, storedPath.slice(prefix.length));
    }
  }
  return path.join(meta.sourcePath, meta.sourceRoot || '', storedPath);
}

export async function dropKb(name) {
  await deleteKb(name);
}

export async function getKbMeta(name) {
  return getMeta(name);
}

export async function listKbs() {
  const { listKbs: ls } = await import('../store/kb_store.js');
  return ls();
}

export async function getStats(name) {
  const meta = await getMeta(name);
  if (!meta) return null;
  const stats = await readStats(name);
  return { meta, stats };
}

export async function resolveSourceFile(name, relPath) {
  const meta = await getMeta(name);
  if (!meta) throw new Error(`KB ${name} not found`);
  return path.join(meta.sourcePath, meta.sourceRoot || '', relPath);
}
