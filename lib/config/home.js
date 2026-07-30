/**
 * $HOME/.hk2 config layer — the single source of truth for hk2 configuration.
 *
 * Layout:
 *   ~/.hk2/
 *     models.json           Multi-provider model registry
 *     projects.json         Project registry + current pointer
 *     kb/<projectId>/       Per-project KB
 *     sessions/<projectId>/ JSONL session transcripts
 *     logs/
 *
 * Environment:
 *   HK2_HOME    Override ~/.hk2 location (dev/test)
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeJsonAtomic, readJsonSafe, exists, writeFileAtomic, readFileSafe } from '../util/fs_atomic.js';
import { randomUUID } from 'node:crypto';

export const HK2_HOME = path.resolve(
  process.env.HK2_HOME || path.join(os.homedir(), '.hk2')
);

export const MODELS_PATH = path.join(HK2_HOME, 'models.json');
export const PROJECTS_PATH = path.join(HK2_HOME, 'projects.json');
export const KB_ROOT = path.join(HK2_HOME, 'kb');
export const SESSIONS_ROOT = path.join(HK2_HOME, 'sessions');
export const LOGS_ROOT = path.join(HK2_HOME, 'logs');

/**
 * Default include / exclude globs. Cover common source languages so any
 * generic coding project works out of the box. /project init uses these
 * unless the caller overrides.
 */
export const DEFAULT_INCLUDE_GLOBS = [
  // C / C++
  '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.cxx',
  // JS / TS
  '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
  // Python
  '**/*.py',
  // Go / Rust / Java / Kotlin / Scala
  '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.scala',
  // Ruby / PHP / Swift
  '**/*.rb', '**/*.php', '**/*.swift',
  // Shell / config / build
  '**/*.sh', '**/*.bash', '**/*.zsh',
  // Parser generators (lex / yacc)
  '**/*.y', '**/*.l',
  // Documents (Markdown, plain text, JSON, YAML, HTML)
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.html', '**/*.htm',
];
export const DEFAULT_EXCLUDE_GLOBS = [
  // Generated parser files (typical outputs from lex/yacc and similar)
  '**/gram.c', '**/scan.c', '**/kwlist.c',
  // Vendored / build artifacts
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/target/**',
  '**/.venv/**', '**/vendor/**', '**/__pycache__/**',
  // VCS
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  // Editor / IDE state
  '**/.idea/**', '**/.vscode/**', '**/.DS_Store',
];

/* ------------------------------------------------------------------ */
/* initialization                                                    */
/* ------------------------------------------------------------------ */

export async function ensureHome() {
  await fs.mkdir(HK2_HOME, { recursive: true });
  await fs.mkdir(KB_ROOT, { recursive: true });
  await fs.mkdir(SESSIONS_ROOT, { recursive: true });
  await fs.mkdir(LOGS_ROOT, { recursive: true });
  if (!await exists(MODELS_PATH)) await writeJsonAtomic(MODELS_PATH, await defaultModels());
  if (!await exists(PROJECTS_PATH)) await writeJsonAtomic(PROJECTS_PATH, defaultProjects());
}

/* ------------------------------------------------------------------ */
/* models.json                                                        */
/* ------------------------------------------------------------------ */

/**
 * Default models.json. Seeds the registry from environment variables only —
 * no on-disk fallback. Users add providers/models via /model add.
 *
 * Picks up ANTHROPIC_API_KEY / OPENAI_API_KEY from env (skipped if unset,
 * to avoid empty providers in /model list).
 */
async function defaultModels() {
  const providers = {};
  let defaultModel = null;

  if (process.env.ANTHROPIC_API_KEY) {
    const name = 'anthropic';
    providers[name] = {
      api: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      models: [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 200000, maxTokens: 32000, reasoning: true, temperature: 0.2 },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000, maxTokens: 32000, reasoning: true, temperature: 0.2 },
      ],
    };
    if (!defaultModel) defaultModel = `${name}/claude-sonnet-4-6`;
  }
  if (process.env.OPENAI_API_KEY) {
    const name = 'openai';
    providers[name] = {
      api: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384, reasoning: false, temperature: 0.2 },
      ],
    };
    if (!defaultModel) defaultModel = `${name}/gpt-4o`;
  }

  return { providers, default: defaultModel };
}

function defaultProjects() {
  return { current: null, projects: {} };
}

/**
 * Load the full models.json.
 * @returns {Promise<{providers: Object, default: string|null}>}
 */
export async function loadModels() {
  await ensureHome();
  const data = await readJsonSafe(MODELS_PATH, null);
  if (!data || typeof data !== 'object') return { providers: {}, default: null };
  return {
    providers: data.providers && typeof data.providers === 'object' ? data.providers : {},
    default: typeof data.default === 'string' ? data.default : null,
  };
}

export async function saveModels(data) {
  await ensureHome();
  await writeJsonAtomic(MODELS_PATH, data);
}

/** Split "provider/model" into {provider, model}; returns null on invalid input. */
export function splitModelRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const idx = ref.indexOf('/');
  if (idx <= 0 || idx === ref.length - 1) return null;
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

/**
 * Resolve the default model into a config object usable by LLMClient.
 * @returns {Promise<{style, baseUrl, apiKey, model, maxChars, temperature, enableReasoning, timeout} | null>}
 */
export async function resolveDefaultModel() {
  const { providers, default: defaultRef } = await loadModels();
  if (!defaultRef) return null;
  return resolveModelRef(defaultRef);
}

export async function resolveModelRef(ref) {
  const split = splitModelRef(ref);
  if (!split) return null;
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov || !Array.isArray(prov.models)) return null;
  const m = prov.models.find(x => x.id === split.model);
  if (!m) return null;
  return {
    ref,
    style: (prov.api || 'openai').toLowerCase(),
    baseUrl: prov.baseUrl || '',
    apiKey: prov.apiKey || '',
    headers: prov.headers || null,
    model: m.id,
    maxChars: m.contextWindow || 65536,
    temperature: m.temperature ?? 0.2,
    enableReasoning: m.reasoning ?? false,
    timeout: 600000,
  };
}

/* ------------------------------------------------------------------ */
/* projects.json                                                      */
/* ------------------------------------------------------------------ */

export async function loadProjects() {
  await ensureHome();
  const data = await readJsonSafe(PROJECTS_PATH, null);
  if (!data || typeof data !== 'object') return { current: null, projects: {} };
  return {
    current: typeof data.current === 'string' ? data.current : null,
    projects: data.projects && typeof data.projects === 'object' ? data.projects : {},
  };
}

export async function saveProjects(data) {
  await ensureHome();
  await writeJsonAtomic(PROJECTS_PATH, data);
}

/**
 * Register a new project: generate a UUID and write it to projects.json.
 * Does NOT create the KB directory (KB creation is explicit via /kb init,
 * to avoid leaving empty dirs around).
 *
 * @param {{name?: string, sourcePath: string, sourceRoot?: string, includeGlobs?: string[], excludeGlobs?: string[], extraRoots?: Array}} opts
 * @returns {Promise<object>} project record
 */
export async function registerProject(opts) {
  if (!opts || !opts.sourcePath) throw new Error('sourcePath required');
  const absSource = path.resolve(opts.sourcePath);
  if (!await exists(absSource)) throw new Error(`source path not found: ${absSource}`);
  const sourceRoot = opts.sourceRoot || '';
  const rootAbs = sourceRoot ? path.join(absSource, sourceRoot) : absSource;
  if (!await exists(rootAbs)) throw new Error(`source root not found: ${rootAbs}`);

  const id = opts.id || randomUUID();
  const rec = {
    id,
    name: opts.name || path.basename(absSource),
    sourcePath: absSource,
    sourceRoot,
    extraRoots: Array.isArray(opts.extraRoots) ? opts.extraRoots : [],
    includeGlobs: opts.includeGlobs && opts.includeGlobs.length ? opts.includeGlobs : DEFAULT_INCLUDE_GLOBS,
    excludeGlobs: opts.excludeGlobs && opts.excludeGlobs.length ? opts.excludeGlobs : DEFAULT_EXCLUDE_GLOBS,
    kbBuiltAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const data = await loadProjects();
  data.projects[id] = rec;
  if (!data.current) data.current = id;
  await saveProjects(data);
  return rec;
}

export async function getProject(id) {
  const { projects } = await loadProjects();
  return projects[id] || null;
}

export async function getCurrentProject() {
  const { current, projects } = await loadProjects();
  if (!current) return null;
  return projects[current] || null;
}

export async function setCurrentProject(idOrName) {
  const data = await loadProjects();
  let found = null;
  for (const p of Object.values(data.projects)) {
    if (p.id === idOrName || p.name === idOrName) { found = p; break; }
  }
  if (!found) return null;
  data.current = found.id;
  await saveProjects(data);
  return found;
}

export async function updateProject(id, patch) {
  const data = await loadProjects();
  if (!data.projects[id]) return null;
  data.projects[id] = {
    ...data.projects[id],
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
  };
  await saveProjects(data);
  return data.projects[id];
}

export async function removeProject(id) {
  const data = await loadProjects();
  if (!data.projects[id]) return false;
  delete data.projects[id];
  if (data.current === id) {
    const remaining = Object.keys(data.projects);
    data.current = remaining.length ? remaining[0] : null;
  }
  await saveProjects(data);
  return true;
}

export async function listProjects() {
  const { current, projects } = await loadProjects();
  return { current, projects: Object.values(projects) };
}

/** Mark the project's KB as built (updates kbBuiltAt). Used by /kb init. */
export async function markKbBuilt(id) {
  return updateProject(id, { kbBuiltAt: new Date().toISOString() });
}

/* ------------------------------------------------------------------ */
/* Legacy compatibility: derive KB_ROOT/<project> directory paths      */
/* ------------------------------------------------------------------ */

/** KB directory: ~/.hk2/kb/<projectId>/ */
export function projectKbDir(projectId) {
  return path.join(KB_ROOT, projectId);
}

/** File inside a KB: ~/.hk2/kb/<projectId>/<name> */
export function projectKbPath(projectId, name) {
  return path.join(projectKbDir(projectId), name);
}

/** Session file: ~/.hk2/sessions/<projectId>/<sessionId>.jsonl */
export function projectSessionPath(projectId, sessionId) {
  return path.join(SESSIONS_ROOT, projectId, `${sessionId}.jsonl`);
}

export { readFileSafe, writeFileAtomic };
