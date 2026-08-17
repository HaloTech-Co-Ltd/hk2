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
 * Supported model types. A model type describes the model family / vendor
 * characteristics so hk2 can apply model-specific behavior later. Only these
 * values are accepted by `/model add|set --model-type`; anything else is
 * rejected so the registry stays consistent. `generic` is the default for
 * models that have no known type.
 */
const MODEL_TYPES = [
  'claude-fable-5',
  'claude-opus-4.8',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-haiku-4.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'qwen-3.8-max',
  'qwen-3.8',
  'qwen-3.7-max',
  'qwen-3.7',
  'qwen-3.6',
  'qwen-3.5',
  'qwen-3',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.7-flash',
  'kimi-k3',
  'kimi-k2.7',
  'kimi-k2.6',
  'generic',
];

const KNOWN_MODEL_TYPES = new Set(MODEL_TYPES);

export const DEFAULT_MODEL_TYPE = 'generic';

/** User-facing model types supported by /model add|set --model-type, for help text. */
export function supportedModelTypes() {
  return MODEL_TYPES.slice();
}

/**
 * Normalize a user-supplied model type into its canonical value. Accepts
 * case-insensitive input and returns null for unknown types so callers can
 * surface a clear error. Callers decide the fallback (DEFAULT_MODEL_TYPE)
 * when the flag is omitted.
 */
export function normalizeModelType(type) {
  if (!type || typeof type !== 'string') return null;
  const key = type.trim().toLowerCase();
  return KNOWN_MODEL_TYPES.has(key) ? key : null;
}

/**
 * Per-model-type feature declarations.
 *
 * A model type declares the model-specific behavior hk2 applies when the
 * model's `modelType` matches: feature OPTION enums validated by
 * /model add|set (and normalized at resolve time), plus a per-type default
 * for the `reasoning` flag. Wire mapping (what actually goes into the API
 * request body) lives in the protocol adapters — see applyModelTypeFeatures
 * in lib/llm/openai_adapter.js.
 *
 * glm-5.3 (BigModel): deep-reasoning model. Reasoning is on by default and
 * the effort level is selectable via the `reasoning_effort` option:
 *   max  (default and recommended — deep reasoning)
 *   high (enhanced reasoning)
 *   low  (light reasoning)
 * Sent on the OpenAI-style endpoint as `thinking:{type:'enabled'}` plus
 * `reasoning_effort` — mirroring the BigModel v4 chat/completions API.
 */
export const MODEL_TYPE_FEATURES = {
  'glm-5.3': {
    defaultReasoning: true,
    options: {
      reasoning_effort: {
        values: ['max', 'high', 'low'],
        default: 'max',
      },
    },
  },
};

/** Feature descriptor for a model type, or null when the type declares none. */
export function modelTypeFeatures(type) {
  if (!type || typeof type !== 'string') return null;
  return MODEL_TYPE_FEATURES[type.trim().toLowerCase()] || null;
}

/** Whether a model type defaults `reasoning` to on (e.g. glm-5.3). */
export function modelTypeDefaultReasoning(type) {
  return modelTypeFeatures(type)?.defaultReasoning === true;
}

/**
 * Validate user-supplied model options against the enum declared for a model
 * type. Returns null when everything is valid (or the type declares no
 * features), else a human-readable error message naming the valid values.
 */
export function validateModelOptionsForType(type, options) {
  const feats = modelTypeFeatures(type);
  if (!feats || !options || typeof options !== 'object') return null;
  for (const [key, spec] of Object.entries(feats.options || {})) {
    if (!(key in options)) continue;
    const v = options[key];
    const norm = (typeof v === 'string' || typeof v === 'number') ? String(v).trim().toLowerCase() : '';
    if (!spec.values.includes(norm)) {
      return `${key} must be one of: ${spec.values.join(', ')} (got ${JSON.stringify(v)})`;
    }
  }
  return null;
}

/**
 * Effective model options for a model type: the stored object with declared
 * option enums normalized (case-insensitively) and defaults filled in.
 * Unknown stored values fall back to the declared default (the CLI rejects
 * them up front; this covers hand-edited models.json records). Keys the type
 * does not govern pass through untouched. Always returns a fresh object.
 */
export function effectiveModelOptions(type, stored) {
  const out = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? { ...stored } : {};
  const feats = modelTypeFeatures(type);
  if (feats) {
    for (const [key, spec] of Object.entries(feats.options || {})) {
      const norm = typeof out[key] === 'string' ? out[key].trim().toLowerCase() : undefined;
      out[key] = (norm !== undefined && spec.values.includes(norm)) ? norm : spec.default;
    }
  }
  return out;
}

/**
 * Effective reasoning_effort for a model type, or null when the type does
 * not declare the knob. Shared by both protocol adapters so the OpenAI-style
 * endpoint (`thinking:{type:'enabled'}` + `reasoning_effort`) and the
 * Anthropic-style endpoint (thinking block + `reasoning_effort`) stay in
 * lock-step from one declaration (e.g. glm-5.3 max/high/low, default max).
 */
export function modelTypeReasoningEffort(type, stored) {
  const feats = modelTypeFeatures(type);
  if (!feats?.options?.reasoning_effort) return null;
  return effectiveModelOptions(type, stored).reasoning_effort ?? feats.options.reasoning_effort.default;
}

/** Default model options: an empty object, i.e. no model-specific options. */
export const DEFAULT_MODEL_OPTIONS = {};

/**
 * Parse and validate a user-supplied model options value (--model-options).
 * The value must be a JSON OBJECT string (e.g.
 * '{"thinking":{"type":"enabled"}}'); any number of model-specific keys is
 * allowed. Returns the parsed plain object, or null when the input is
 * missing/malformed so callers can surface a clear error before mutating the
 * registry. An explicit empty JSON object '{}' is valid and means "no
 * options" (it clears any previously stored value).
 */
export function normalizeModelOptions(raw) {
  if (raw === undefined || raw === null) return null;
  // Defensive: accept an already-parsed plain object (round-trip from code).
  if (typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/* ------------------------------------------------------------------ */
/* MCP servers (/model add-mcpserver)                                 */
/* ------------------------------------------------------------------ */

/**
 * Supported MCP (Model Context Protocol) server service types, selected
 * via /model add-mcpserver --type=. `http` is implemented; `stdio` is
 * reserved for future extension (kept in the enum so the CLI can give a
 * clear "not implemented yet" message instead of "unknown type").
 */
const MCP_SERVER_TYPES = ['http', 'stdio'];

export function supportedMcpServerTypes() {
  return MCP_SERVER_TYPES.slice();
}

/** Normalize an --type value; returns 'http' | 'stdio', or null when unknown. */
export function normalizeMcpServerType(type) {
  if (typeof type !== 'string') return null;
  const t = type.trim().toLowerCase();
  return MCP_SERVER_TYPES.includes(t) ? t : null;
}

/**
 * Credential placeholder recognized inside http MCP server options
 * (`url` and header values): `$APIKEY` (and the brace form `${APIKEY}`).
 * Written as a literal placeholder in models.json, substituted from the
 * model's provider apiKey at read time by getModelMcpServers — the stored
 * record never contains a copy of the key.
 */
const APIKEY_PLACEHOLDER_RE = /\$\{?APIKEY\}?/g;

/** True when a string value carries the $APIKEY placeholder. */
export function hasApikeyPlaceholder(value) {
  return typeof value === 'string' && /\$\{?APIKEY\}?/.test(value);
}

/**
 * Parse and validate --options JSON for an MCP server of the given type.
 * Options are type-specific; today only `http` is implemented:
 *   { "url": string (required, non-empty), "headers": { name: value } (optional) }
 * Unknown keys are rejected so typos (e.g. "header") surface immediately.
 *
 * @returns {{options: object}|{error: string}} parsed options or a
 *   user-facing error message; never null.
 */
export function normalizeMcpServerOptions(type, raw) {
  if (type === 'stdio') {
    return { error: `MCP server type "stdio" is not implemented yet (currently implemented: http)` };
  }
  if (type !== 'http') {
    return { error: `unknown MCP server type: ${type} (supported types: ${MCP_SERVER_TYPES.join(', ')})` };
  }
  const parsed = normalizeModelOptions(raw);
  if (!parsed) {
    return { error: `expected a JSON object, e.g. --options='{"url":"https://example.com/mcp","headers":{"Authorization":"Bearer ..."}}'` };
  }
  if (typeof parsed.url !== 'string' || !parsed.url.trim()) {
    return { error: `"url" is required for http MCP servers (non-empty string)` };
  }
  if (parsed.headers !== undefined) {
    const h = parsed.headers;
    const bad = typeof h !== 'object' || h === null || Array.isArray(h)
      || Object.values(h).some(v => typeof v !== 'string');
    if (bad) {
      return { error: `"headers" must be an object mapping header names to string values` };
    }
  }
  const unknown = Object.keys(parsed).filter(k => k !== 'url' && k !== 'headers');
  if (unknown.length > 0) {
    return { error: `unsupported http option(s): ${unknown.join(', ')} (supported: url, headers)` };
  }
  return { options: parsed };
}

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

  // NOTE on `name`: it is the model code SENT IN THE API REQUEST BODY (the
  // wire `model` field), NOT a human-readable label. `id` is the
  // provider/accounting key used in `provider/id` refs and MAY carry a
  // trailing bracketed context-window hint (e.g. `glm-5.2[1m]`, a Volcengine
  // ark convention) that several Anthropic-compatible gateways reject
  // (BigModel open.bigmodel.cn/api/anthropic returns `modelCode不存在` when
  // it gets the whole `glm-5.2[1m]`). So resolveModelRef sends `name`, never
  // `id`. For the bundled seeds `name === id` (no hint to strip); listModels
  // dedupes them, so a distinct label is only printed when the user sets one.
  if (process.env.ANTHROPIC_API_KEY) {
    const name = 'anthropic';
    providers[name] = {
      api: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      models: [
        { id: 'claude-opus-4-7', name: 'claude-opus-4-7', contextWindow: 200000, maxTokens: 32000, reasoning: true, temperature: 0.2 },
        { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', contextWindow: 200000, maxTokens: 32000, reasoning: true, temperature: 0.2 },
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
        { id: 'gpt-4o', name: 'gpt-4o', contextWindow: 128000, maxTokens: 16384, reasoning: false, temperature: 0.2 },
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
 * Mapping from user-facing CLI phase names (e.g. --phase=rewrite-query) to the
 * internal storage keys used inside a project record's `phaseModels` object
 * (e.g. 'rewriteQuery'). Adding a phase here is the only change needed to
 * support configuring a model for a new phase.
 */
const PHASE_KEYS = {
  'rewrite-query': 'rewriteQuery',
  'request-assess': 'requestAssess',
  'plan-review': 'planReview',
  'code-review': 'codeReview',
};

/** Known phase storage keys (the values of PHASE_KEYS), for validation. */
const KNOWN_PHASES = new Set(Object.values(PHASE_KEYS));

/**
 * Normalize a user-supplied phase name into the internal storage key.
 * Accepts the kebab-case CLI form ('rewrite-query') and is case-insensitive.
 * Returns null for unknown phases so callers can surface a clear error.
 */
export function normalizePhaseName(name) {
  if (!name || typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  return PHASE_KEYS[key] || null;
}

/** User-facing CLI names supported by /model set-phase, for help text. */
export function supportedPhaseNames() {
  return Object.keys(PHASE_KEYS);
}

/**
 * Reverse of normalizePhaseName: given an internal storage key (e.g.
 * 'rewriteQuery'), return the user-facing CLI phase name (e.g. 'rewrite-query'),
 * or null when the storage key is unknown. Used by /project show so the
 * displayed phase labels match what the user typed into
 * `/model set-phase --phase=...`.
 */
export function phaseStorageKeyToCliName(storageKey) {
  if (!storageKey || typeof storageKey !== 'string') return null;
  for (const [cliName, key] of Object.entries(PHASE_KEYS)) {
    if (key === storageKey) return cliName;
  }
  return null;
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
  const modelType = typeof m.modelType === 'string' ? m.modelType : DEFAULT_MODEL_TYPE;
  const feats = modelTypeFeatures(modelType);
  return {
    ref,
    style: (prov.api || 'openai').toLowerCase(),
    baseUrl: prov.baseUrl || '',
    apiKey: prov.apiKey || '',
    headers: prov.headers || null,
    // The WIRE model code sent in the API request body comes from the model's
    // `name` (configured via /model add|set --name), NOT from `id`. `id` is
    // the provider/accounting key and may carry a trailing bracketed
    // context-window hint (e.g. `glm-5.2[1m]`) that several gateways reject
    // (BigModel returns `modelCode不存在`). Letting `name` hold the exact API
    // code keeps `id` free to carry display hints / context selectors.
    // Fall back to `id` only for legacy records that never set `name`, where
    // there is no hint to worry about.
    model: (typeof m.name === 'string' && m.name) ? m.name : m.id,
    modelType,
    // Model-specific feature options (--model-options), stored as a JSON
    // object with a free-form, model-specific key set. Types with declared
    // features (MODEL_TYPE_FEATURES, e.g. glm-5.3's reasoning_effort) get
    // their enums normalized and defaults filled here; legacy records
    // without the field resolve to the type's defaults / {}.
    modelOptions: effectiveModelOptions(modelType, m.modelOptions),
    maxChars: m.contextWindow || 65536,
    temperature: m.temperature ?? 0.2,
    // glm-5.3 defaults reasoning ON (deep-reasoning model); explicit
    // `reasoning:false` on the entry always wins.
    enableReasoning: m.reasoning ?? (feats?.defaultReasoning ?? false),
    timeout: 600000,
  };
}

/*
 * Read the MCP servers attached to a model entry (written by
 * /model add-mcpserver), with the $APIKEY placeholder RESOLVED.
 *
 * Substitution: every `$APIKEY` / `${APIKEY}` occurrence in the server's
 * `url` and header values is replaced by the provider's apiKey (the same
 * credential configured via /model add --api-key). This lets a user attach
 * a server without retyping the key, e.g.
 *   --options='{"url":"...","headers":{"Authorization":"Bearer $APIKEY"}}'
 * A provider with no apiKey resolves the placeholder to ''.
 *
 * The stored record keeps the literal placeholder — resolution happens on a
 * deep copy returned here (callers may freely mutate the result). Returns
 * the server array (empty for models without servers), or null when the
 * provider/model ref is unknown. Pass { resolve: false } to get the stored
 * (placeholder-preserving) copy — used by display code that must not print
 * resolved credentials.
 */
export async function getModelMcpServers(ref, { resolve = true } = {}) {
  const split = splitModelRef(ref);
  if (!split) return null;
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  const entry = (prov && Array.isArray(prov.models)) ? prov.models.find(x => x.id === split.model) : null;
  if (!entry) return null;
  if (!Array.isArray(entry.mcpServers)) return [];
  const apiKey = (prov && typeof prov.apiKey === 'string') ? prov.apiKey : '';
  const sub = (v) => (resolve && hasApikeyPlaceholder(v) ? v.replace(APIKEY_PLACEHOLDER_RE, apiKey) : v);
  return entry.mcpServers.map(s => {
    const out = { type: s.type, name: s.name, options: {} };
    if (s.options && typeof s.options === 'object') {
      if (typeof s.options.url === 'string') out.options.url = sub(s.options.url);
      if (s.options.headers && typeof s.options.headers === 'object' && !Array.isArray(s.options.headers)) {
        out.options.headers = Object.fromEntries(
          Object.entries(s.options.headers).map(([k, v]) => [k, sub(v)]),
        );
      }
    }
    return out;
  });
}

/* ------------------------------------------------------------------ */
/* projects.json                                                      */
/* ------------------------------------------------------------------ */

export async function loadProjects() {
  await ensureHome();
  const data = await readJsonSafe(PROJECTS_PATH, null);
  if (!data || typeof data !== 'object') return { current: null, projects: {} };
  const raw = data.projects && typeof data.projects === 'object' ? data.projects : {};
  const projects = {};
  // Normalize each record so phaseModels is always a plain object, even for
  // projects created before this field existed. This keeps downstream callers
  // (getPhaseModelRef / setPhaseModelRef / /project show) branch-free.
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    projects[id] = {
      ...p,
      phaseModels: (p.phaseModels && typeof p.phaseModels === 'object' && !Array.isArray(p.phaseModels)) ? p.phaseModels : {},
    };
  }
  return {
    current: typeof data.current === 'string' ? data.current : null,
    projects,
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
    phaseModels: {},
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

/**
 * Resolve the configured model ref for a phase on a project. Returns null when
 * the phase is unknown or no model is configured for it (the default behavior:
 * callers then fall back to the current session model).
 *
 * @param {object|null|undefined} project  project record (e.g. session.project)
 * @param {string} phase  user-facing phase name, e.g. 'rewrite-query'
 * @returns {string|null} model ref like 'provider/model-id', or null
 */
export function getPhaseModelRef(project, phase) {
  const key = normalizePhaseName(phase);
  if (!key || !project || !project.phaseModels) return null;
  const ref = project.phaseModels[key];
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Persist a model ref for a phase on a project. Merges into the existing
 * phaseModels object (other phases are preserved). Returns the updated project
 * record, or null when the project or phase is unknown, or when `ref` is empty
 * (use clearPhaseModelRef to remove a phase override).
 */
export async function setPhaseModelRef(projectId, phase, ref) {
  const key = normalizePhaseName(phase);
  if (!key) return null;
  if (!ref || typeof ref !== 'string') return null;
  const data = await loadProjects();
  const cur = data.projects[projectId];
  if (!cur) return null;
  const phaseModels = { ...(cur.phaseModels || {}), [key]: ref };
  return updateProject(projectId, { phaseModels });
}

/**
 * Remove a phase model override from a project (so the phase falls back to the
 * current session model). No-op when the project/phase is unknown or nothing
 * was configured. Returns the updated project record (or null).
 */
export async function clearPhaseModelRef(projectId, phase) {
  const key = normalizePhaseName(phase);
  if (!key) return null;
  const data = await loadProjects();
  const cur = data.projects[projectId];
  if (!cur) return null;
  if (!cur.phaseModels || !(key in cur.phaseModels)) return cur;
  const phaseModels = { ...cur.phaseModels };
  delete phaseModels[key];
  return updateProject(projectId, { phaseModels });
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

/** Task-state file (interruption recovery): ~/.hk2/sessions/<projectId>/taskstate.json */
export function projectTaskStatePath(projectId) {
  return path.join(SESSIONS_ROOT, projectId, 'taskstate.json');
}

export { readFileSafe, writeFileAtomic };
