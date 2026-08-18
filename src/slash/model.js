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
 * /model command family - manage ~/.hk2/models.json.
 *
 * Usage:
 *   /model list                                    List all providers / models
 *   /model use <provider>/<model-id>               Choose model for current session only
 *   /model set-default <provider>/<model-id>       Set global default model (persisted)
 *   /model set-default current <provider>/<model-id>
 *                                                  Set the current project's default model
 *   /model set-default current --clear              Clear the project override (fall back to global)
 *   /model set <provider>/<model-id> [--name=...] [--id=NEW_ID] [--api=...] [--base-url=...] [--api-key=...]
 *                  [--reasoning=on|off] [--context-window=N] [--max-tokens=N] [--temperature=N] [--model-type=TYPE]
 *                  [--model-options=JSON]
 *                                                  Modify a model's persisted settings
 *   /model set-phase --phase=<name> <provider>/<model-id> [--clear]
 *                                                  Per-project model for one pipeline phase
 *   /model add <provider> <model-id> [--flags]     Add a new model (creates provider if needed)
 *   /model del <provider>/<model-id>               Delete a model
 *   /model types                                   List all supported --model-type values
 *   /model show                                    Show current default
 *   /model add-mcpserver <provider>/<model-id> --type=TYPE --name=NAME [--options=JSON]
 *                                                  Attach an MCP server to an existing model
 */
import {
  loadModels, saveModels, splitModelRef, resolveModelRef,
  loadProjects, saveProjects,
  normalizePhaseName, supportedPhaseNames,
  setPhaseModelRef, clearPhaseModelRef,
  getProjectDefaultModelRef, setProjectDefaultModelRef, clearProjectDefaultModelRef,
  normalizeModelType, supportedModelTypes, DEFAULT_MODEL_TYPE,
  normalizeModelOptions, modelTypeFeatures, modelTypeDefaultReasoning,
  validateModelOptionsForType,
  normalizeMcpServerType, normalizeMcpServerOptions,
  supportedMcpServerTypes, getModelMcpServers,
} from '../../lib/config/home.js';
import { subcommandHelp, printCommandHelp } from './help.js';

export async function cmdModel(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list': case 'ls': return listModels(ctx);
    case 'use': return useModel(rest, ctx);
    case 'set-default': return setDefaultModel(rest, ctx);
    case 'set': return setModel(rest, ctx);
    case 'set-phase': return setPhaseModel(rest, ctx);
    case 'add': return addModel(rest, ctx);
    case 'del': case 'rm': return delModel(rest, ctx);
    case 'add-mcpserver': return addMcpServer(rest, ctx);
    case 'show': return showModel(ctx);
    case 'types': return listModelTypes(ctx);
    case 'help': case '?': case undefined:
      // '/model help <x>' drills into one subcommand's usage block.
      if (sub !== undefined && rest[0]) {
        const topic = rest[0];
        const lines = subcommandHelp('model', topic);
        if (lines) {
          for (const l of lines) ctx.print(l);
          return;
        }
        ctx.print(`Unknown /model topic: ${topic}`);
        ctx.print(`Type /model help for the full list.`);
        return;
      }
      printCommandHelp(ctx, 'model');
      return;
    default:
      ctx.print(`Unknown /model subcommand: ${sub}`);
      printCommandHelp(ctx, 'model');
  }
}

/**
 * /model types — list every supported --model-type value.
 * Backed by supportedModelTypes() in lib/config/home.js so it can never drift
 * from the actual validation set.
 */
function listModelTypes(ctx) {
  const types = supportedModelTypes();
  ctx.print(`Supported --model-type values (${types.length}):`);
  ctx.print(`  ${types.join(', ')}`);
  ctx.print(``);
  ctx.print(`Default when omitted: ${DEFAULT_MODEL_TYPE}`);
  ctx.print(`Used by: /model add <provider> <model-id> --model-type=<TYPE>`);
  ctx.print(`        /model set <provider>/<model-id> --model-type=<TYPE>`);
}

async function listModels(ctx) {
  const { providers, default: def } = await loadModels();
  const names = Object.keys(providers);
  // Show the current project's default-model override next to the global
  // default so /model list reflects what a bare session on this project
  // would actually use (same precedence as resolveDefaultModel).
  let projRef = null;
  try {
    const getter = ctx.getCurrentProject || (async () => (await import('../../lib/config/home.js')).getCurrentProject());
    projRef = getProjectDefaultModelRef(await getter.call(ctx));
  } catch { /* non-interactive callers without a project registry */ }
  if (names.length === 0) {
    ctx.print(`(empty. Use /model add <provider> <model-id> to add one)`);
    return;
  }
  ctx.print(`Models (default: ${def || '(none)'}${projRef ? `, project default: ${projRef}` : ''})`);
  for (const pname of names) {
    const p = providers[pname];
    ctx.print(``);
    ctx.print(`[${pname}]  api=${p.api || 'openai'}  baseUrl=${p.baseUrl || '(default)'}`);
    for (const m of (p.models || [])) {
      const ref = `${pname}/${m.id}`;
      const isDef = ref === def;
      const isProjDef = projRef === ref;
      // '*' marks the global default; '+' marks the current project's default
      // override (both when they coincide).
      const marker = `${isDef ? '*' : ' '}${isProjDef ? '+' : ' '}`;
      // `name` is now the WIRE model code (sent to the API), so only append it
      // to the listing when it DIFFERS from `id` - otherwise the row would read
      // `gpt-4o gpt-4o`. When they differ, showing both lets the user see the
      // ref key (id) and the wire code (name) side by side.
      const label = (m.name && m.name !== m.id) ? `${m.id.padEnd(28)} -> ${m.name}` : m.id.padEnd(28);
      ctx.print(`${marker} ${label}`);
      ctx.print(`    contextWindow=${m.contextWindow || '?'} maxTokens=${m.maxTokens || '?'} reasoning=${m.reasoning ? 'on' : 'off'} temperature=${m.temperature ?? 0.2} modelType=${m.modelType || 'generic'}`);
      printModelOptions(ctx, m.modelOptions);
      printMcpServers(ctx, m.mcpServers);
    }
  }
}

/**
 * /model use <provider>/<model-id>
 * Session-only: switches the active model for the current REPL session without
 * touching models.json. Falls back to set-default behavior when the host does
 * not expose ctx.setModel (e.g. non-interactive callers), so the command still
 * does something useful everywhere.
 */
async function useModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) { ctx.print(`Usage: /model use <provider>/<model-id>  (session only; use /model set-default to persist)`); return; }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const m = (prov.models || []).find(x => x.id === split.model);
  if (!m) { ctx.print(`Model not found: ${ref}`); return; }
  if (typeof ctx.setModel === 'function') {
    const cfg = await resolveModelRef(ref);
    if (!cfg) { ctx.print(`Unable to resolve model: ${ref}`); return; }
    ctx.setModel(cfg);
    ctx.print(`Session model: ${ref} (session only - not persisted)`);
    return;
  }
  // Fallback for contexts without setModel (e.g. serve / one-shot): persist as default.
  const data = await loadModels();
  data.default = ref;
  await saveModels(data);
  ctx.print(`Default set: ${ref}`);
  ctx.noteReloadModels?.();
}

/**
 * /model set-default <provider>/<model-id>
 * /model set-default current <provider>/<model-id>
 * /model set-default current --clear
 *
 * Persist the default model. Without `current` this writes the GLOBAL default
 * in models.json (used by every project without its own override). With
 * `current` it writes the CURRENT project's defaultModel override in
 * projects.json — when set, that project resolves its default model from the
 * override; when unset (or cleared), it falls back to the global default.
 */
async function setDefaultModel(rest, ctx) {
  if (rest[0] === 'current') return setDefaultModelForProject(rest.slice(1), ctx);
  const ref = rest[0];
  if (!ref) {
    ctx.print(`Usage: /model set-default <provider>/<model-id>`);
    ctx.print(`       /model set-default current <provider>/<model-id>`);
    ctx.print(`       /model set-default current --clear`);
    return;
  }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const m = (prov.models || []).find(x => x.id === split.model);
  if (!m) { ctx.print(`Model not found: ${ref}`); return; }
  const data = await loadModels();
  data.default = ref;
  await saveModels(data);
  ctx.print(`Default set: ${ref}`);
  ctx.noteReloadModels?.();
}

/**
 * `current` arm of /model set-default: set or clear the CURRENT project's
 * default-model override in projects.json.
 */
async function setDefaultModelForProject(rest, ctx) {
  const flags = parseFlags(rest);
  const wantClear = flags.clear !== undefined;
  // Re-derive the positional ref: parseFlags consumes --clear and its value,
  // so keep every token that is neither a flag nor a captured flag value.
  const usedValues = new Set([typeof flags.clear === 'string' ? flags.clear : '']);
  const positional = rest.filter((t) => !t.startsWith('--') && !usedValues.has(t));
  const ref = positional[0];

  if (!ref && !wantClear) {
    ctx.print(`Usage: /model set-default current <provider>/<model-id> [--clear]`);
    ctx.print(`  Sets the current project's default model (overrides the global default).`);
    ctx.print(`  --clear removes the override (the project falls back to the global default).`);
    return;
  }

  // Resolve the project this session is operating on (same pattern as
  // set-phase: honors the session pin, falls back to the global current).
  const getter = ctx.getCurrentProject || (async () => (await import('../../lib/config/home.js')).getCurrentProject());
  const cur = await getter.call(ctx);
  if (!cur) {
    ctx.print(`No current project. Run /project init or /project set current <id> first.`);
    return;
  }

  if (wantClear) {
    const hadOverride = !!getProjectDefaultModelRef(cur);
    const updated = await clearProjectDefaultModelRef(cur.id);
    if (!updated) {
      ctx.print(`Failed to clear the project default model (project unknown).`);
      return;
    }
    if (!hadOverride) {
      ctx.print(`No project default model was set on ${cur.name} (already using the global default).`);
    } else {
      ctx.print(`Cleared project default model on ${cur.name}. Falling back to the global default.`);
    }
    // Project reload too (mirrors the set path): reloadAll's model branch
    // resolves the default against the session-pinned project RECORD, so the
    // cleared override only takes effect once session.project is refreshed.
    ctx.noteReloadProject?.();
    ctx.noteReloadModels?.();
    return;
  }

  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const m = (prov.models || []).find(x => x.id === split.model);
  if (!m) { ctx.print(`Model not found: ${ref}`); return; }

  const updated = await setProjectDefaultModelRef(cur.id, ref);
  if (!updated) {
    ctx.print(`Failed to set the project default model (project unknown).`);
    return;
  }
  ctx.print(`Project default model set: ${ref} (project: ${cur.name})`);
  ctx.print(`  (overrides the global default for this project only)`);
  // The project reload refreshes session.project (so /project show etc. see
  // the new ref); the model reload re-resolves the effective default via
  // resolveDefaultModel, which now prefers this override. NOTE: we
  // deliberately do NOT ctx.setModel(cfg) here — that would record the ref as
  // a session-only override (session.sessionModelRef) and make it win even
  // after the user later switches projects or clears the override. The
  // enqueue loop's reloadAll applies the new default immediately.
  ctx.noteReloadProject?.();
  ctx.noteReloadModels?.();
}

/**
 * /model set <provider>/<model-id> [--flags]
 * Modify persisted settings of an existing model (and its provider). The model
 * must already exist (use /model add to create). Only the flags you pass are
 * applied; omitted flags keep their current value.
 *
 * Flags:
 *   --name=NAME
 *   --id=NEW_ID                     (rename the model's id / ref key)
 *   --api=openai|anthropic          (provider-level)
 *   --base-url=URL                  (provider-level)
 *   --api-key=KEY                   (provider-level)
 *   --reasoning=on|off
 *   --context-window=N
 *   --max-tokens=N
 *   --temperature=N
 *   --model-type=TYPE
 *   --model-options=JSON   (model-specific feature options, e.g. --model-options='{"enable_thinking":true}')
 */
async function setModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) {
    ctx.print(`Usage: /model set <provider>/<model-id> [--name=NAME] [--id=NEW_ID] [--api=openai|anthropic] [--base-url=URL] [--api-key=KEY]`);
    ctx.print(`                        [--reasoning=on|off] [--context-window=N] [--max-tokens=N] [--temperature=N] [--model-type=TYPE]`);
    ctx.print(`                        [--model-options=JSON]  e.g. --model-options='{"enable_thinking":true}'`);
    return;
  }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const flags = parseFlags(rest.slice(1));

  // Validate --model-type before mutating anything so an invalid value never
  // leaks into the registry.
  let modelType;
  if (flags['model-type'] !== undefined) {
    modelType = normalizeModelType(flags['model-type']);
    if (!modelType) {
      ctx.print(`Unknown model type: ${flags['model-type']}`);
      ctx.print(`Supported model types: ${supportedModelTypes().join(', ')}`);
      return;
    }
  }

  // Validate --model-options JSON shape before touching the registry. The
  // per-type enum check (e.g. glm-5.3 reasoning_effort) runs below, once the
  // entry's effective model type is known.
  let modelOptions;
  if (flags['model-options'] !== undefined) {
    modelOptions = normalizeModelOptions(flags['model-options']);
    if (!modelOptions) {
      ctx.print(`Invalid --model-options: expected a JSON object, e.g. --model-options='{"enable_thinking":true}'`);
      return;
    }
  }

  const data = await loadModels();
  const prov = data.providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const entry = (prov.models || []).find(m => m.id === split.model);
  if (!entry) { ctx.print(`Model not found: ${ref} (use /model add to create it first)`); return; }
  // Effective model type for option validation: the new --model-type when
  // given, else the entry's current (already-normalized) stored type.
  const effectiveModelType = modelType || entry.modelType || DEFAULT_MODEL_TYPE;
  if (modelOptions) {
    // Enum validation against the model type's declared feature options
    // (e.g. glm-5.3 reasoning_effort: max|high|low). Still before any write.
    const typeErr = validateModelOptionsForType(effectiveModelType, modelOptions);
    if (typeErr) {
      ctx.print(`Invalid --model-options: ${typeErr}`);
      return;
    }
  }

  // Optional id rename: /model set <provider>/<old-id> --id=<new-id>.
  // `id` is the provider/accounting key used in provider/id refs; renaming it
  // changes the ref. The effective WIRE model code (from `name`, falling back
  // to the old `id` for legacy records) is preserved across the rename.
  let newRef = ref;
  let pinnedName = false;
  if (flags.id !== undefined) {
    if (typeof flags.id !== 'string' || !flags.id.trim()) {
      ctx.print(`Invalid --id: expected --id=<new-model-id>`);
      return;
    }
    const newId = flags.id.trim();
    if (newId.includes('/')) {
      ctx.print(`Invalid --id: ${flags.id} (model-id must not contain '/')`);
      return;
    }
    if (newId !== split.model && (prov.models || []).some(m => m.id === newId)) {
      ctx.print(`Model already exists: ${split.provider}/${newId} (choose a different --id)`);
      return;
    }
    // Preserve the effective WIRE model code across the rename.
    // resolveModelRef falls back to `id` for records that never set `name`, so
    // renaming those would silently change what is sent to the API (e.g. a
    // rename to `glm-5.2[1m]` would start sending the bracketed hint). Pin
    // `name` to the old effective wire code so the rename only changes the
    // ref key. Records with an explicit name are already pinned by it.
    if (!(typeof entry.name === 'string' && entry.name)) {
      entry.name = split.model;
      pinnedName = true;
    }
    entry.id = newId;
    newRef = `${split.provider}/${newId}`;
    if (data.default === ref) data.default = newRef;
  }

  // Provider-level fields.
  if (flags.api) prov.api = flags.api;
  if (flags['base-url'] !== undefined) prov.baseUrl = flags['base-url'];
  if (flags['api-key'] !== undefined) prov.apiKey = flags['api-key'];

  // Model-level fields.
  if (flags.name) entry.name = flags.name;
  if (flags['context-window'] !== undefined) {
    const n = parseInt(flags['context-window'], 10);
    if (Number.isFinite(n) && n > 0) entry.contextWindow = n;
  }
  if (flags['max-tokens'] !== undefined) {
    const n = parseInt(flags['max-tokens'], 10);
    if (Number.isFinite(n) && n > 0) entry.maxTokens = n;
  }
  if (flags.temperature !== undefined) {
    const t = parseFloat(flags.temperature);
    if (Number.isFinite(t)) entry.temperature = t;
  }
  if (flags.reasoning !== undefined) {
    entry.reasoning = parseBoolFlag(flags.reasoning);
  }
  if (modelType) entry.modelType = modelType;
  // Model-specific options: replace wholesale when the flag is present. An
  // explicit '{}' clears them (stored as an empty object = no options);
  // omitting the flag keeps the current value.
  if (flags['model-options'] !== undefined) entry.modelOptions = modelOptions;

  await saveModels(data);

  // Keep per-project refs pointing at the old id in sync after a rename, so a
  // pinned phase / project default does not silently fall back to the global
  // default. Rewrites: phaseModels entries AND the top-level defaultModel.
  if (newRef !== ref) {
    const projData = await loadProjects();
    let projChanged = false;
    for (const p of Object.values(projData.projects || {})) {
      if (!p || typeof p !== 'object') continue;
      if (p.phaseModels && typeof p.phaseModels === 'object') {
        for (const [phase, phaseRef] of Object.entries(p.phaseModels)) {
          if (phaseRef === ref) {
            p.phaseModels[phase] = newRef;
            projChanged = true;
          }
        }
      }
      if (p.defaultModel === ref) {
        p.defaultModel = newRef;
        projChanged = true;
      }
    }
    if (projChanged) {
      await saveProjects(projData);
      // The in-memory session.project still holds the old refs; signal a
      // project reload so overrides resolve the new ref this session
      // (same mechanism /model set-phase uses after editing a phase ref).
      ctx.noteReloadProject?.();
    }
  }

  ctx.print(`Updated: ${newRef}`);
  ctx.print(`  id=${entry.id} name=${entry.name ?? '?'} contextWindow=${entry.contextWindow ?? '?'} maxTokens=${entry.maxTokens ?? '?'} reasoning=${entry.reasoning ? 'on' : 'off'} temperature=${entry.temperature ?? 0.2} modelType=${entry.modelType || 'generic'}`);
  printModelOptions(ctx, entry.modelOptions);
  if (pinnedName) {
    ctx.print(`  (wire model code preserved: name=${entry.name}; use --name to change what is sent to the API)`);
  }
  // If the session is currently using this model, hot-swap it so the change
  // takes effect immediately without a full reload.
  if (typeof ctx.setModel === 'function' && ctx.modelCfg?.ref === ref) {
    const cfg = await resolveModelRef(newRef);
    if (cfg) ctx.setModel(cfg);
  }
  ctx.noteReloadModels?.();
}

async function addModel(rest, ctx) {
  if (rest.length < 2) {
    ctx.print(`Usage: /model add <provider> <model-id> [--api=openai|anthropic] [--base-url=URL] [--api-key=KEY]`);
    ctx.print(`                        [--reasoning] [--context-window=N] [--max-tokens=N] [--temperature=N] [--name=NAME] [--model-type=TYPE]`);
    ctx.print(`                        [--model-options=JSON]  e.g. --model-options='{"enable_thinking":true}'`);
    return;
  }
  const providerName = rest[0];
  const modelId = rest[1];
  const flags = parseFlags(rest.slice(2));

  // Validate --model-type before mutating anything so an invalid value never
  // leaks into the registry.
  if (flags['model-type'] !== undefined) {
    const mt = normalizeModelType(flags['model-type']);
    if (!mt) {
      ctx.print(`Unknown model type: ${flags['model-type']}`);
      ctx.print(`Supported model types: ${supportedModelTypes().join(', ')}`);
      return;
    }
    flags['model-type'] = mt;
  }

  // Validate --model-options (must be a JSON object) before mutating anything.
  // An explicit '{}' means "no options" (the default state).
  if (flags['model-options'] !== undefined) {
    const mo = normalizeModelOptions(flags['model-options']);
    if (!mo) {
      ctx.print(`Invalid --model-options: expected a JSON object, e.g. --model-options='{"enable_thinking":true}'`);
      return;
    }
    // Enum validation against the model type's declared feature options
    // (e.g. glm-5.3 reasoning_effort: max|high|low).
    const typeErr = validateModelOptionsForType(flags['model-type'], mo);
    if (typeErr) {
      ctx.print(`Invalid --model-options: ${typeErr}`);
      return;
    }
    flags['model-options'] = mo;
  }

  const data = await loadModels();
  let prov = data.providers[providerName];
  if (!prov) {
    prov = {
      api: flags.api || 'openai',
      baseUrl: flags['base-url'] || '',
      apiKey: flags['api-key'] || '',
      models: [],
    };
    data.providers[providerName] = prov;
  } else {
    if (flags.api) prov.api = flags.api;
    if (flags['base-url']) prov.baseUrl = flags['base-url'];
    if (flags['api-key']) prov.apiKey = flags['api-key'];
  }

  let entry = prov.models.find(m => m.id === modelId);
  if (!entry) {
    entry = { id: modelId, name: modelId };
    prov.models.push(entry);
  }
  if (flags.name) entry.name = flags.name;
  if (flags['context-window']) entry.contextWindow = parseInt(flags['context-window'], 10);
  else if (!entry.contextWindow) entry.contextWindow = 65536;
  if (flags['max-tokens']) entry.maxTokens = parseInt(flags['max-tokens'], 10);
  else if (!entry.maxTokens) entry.maxTokens = Math.min(32768, Math.floor((entry.contextWindow || 65536) / 4));
  if (flags.temperature !== undefined) entry.temperature = parseFloat(flags.temperature);
  else if (entry.temperature === undefined) entry.temperature = 0.2;
  if (flags.reasoning !== undefined) entry.reasoning = parseBoolFlag(flags.reasoning);
  else if (entry.reasoning === undefined) entry.reasoning = modelTypeDefaultReasoning(flags['model-type']) ? true : false;
  if (flags['model-type']) entry.modelType = flags['model-type'];
  else if (entry.modelType === undefined) entry.modelType = DEFAULT_MODEL_TYPE;
  // Model-specific feature options: free-form JSON object, default empty
  // (no options). The field is left absent when the flag is omitted on a new
  // entry; resolveModelRef falls back to an empty object for such records.
  if (flags['model-options']) entry.modelOptions = flags['model-options'];

  await saveModels(data);

  if (!data.default) {
    data.default = `${providerName}/${modelId}`;
    await saveModels(data);
    ctx.print(`Added: ${providerName}/${modelId} (set as default)`);
  } else {
    ctx.print(`Added: ${providerName}/${modelId}`);
  }
  ctx.noteReloadModels?.();
}

async function delModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) { ctx.print(`Usage: /model del <provider>/<model-id>`); return; }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref}`); return; }
  const data = await loadModels();
  const prov = data.providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const before = (prov.models || []).length;
  prov.models = (prov.models || []).filter(m => m.id !== split.model);
  if (prov.models.length === 0) {
    delete data.providers[split.provider];
    ctx.print(`Deleted provider (no models left): ${split.provider}`);
  } else if (prov.models.length === before) {
    ctx.print(`Not found: ${ref}`);
    return;
  } else {
    ctx.print(`Deleted: ${ref}`);
  }
  if (data.default === ref) {
    const remaining = Object.entries(data.providers).flatMap(([p, pr]) => (pr.models || []).map(m => `${p}/${m.id}`));
    data.default = remaining[0] || null;
    ctx.print(`(default reset to: ${data.default || '(none)'})`);
  }
  await saveModels(data);
  // Drop per-project references to the deleted model (defaultModel and
  // phaseModels) so a project doesn't carry a ref that can never resolve.
  // resolveDefaultModel / resolvePhaseLlm already fall back silently when a
  // ref is stale, but cleaning here keeps /project show honest.
  const projData = await loadProjects();
  let projChanged = false;
  const cleanedProjects = [];
  for (const p of Object.values(projData.projects || {})) {
    if (!p || typeof p !== 'object') continue;
    let touched = false;
    if (p.defaultModel === ref) {
      p.defaultModel = null;
      touched = true;
    }
    if (p.phaseModels && typeof p.phaseModels === 'object') {
      for (const [phase, phaseRef] of Object.entries(p.phaseModels)) {
        if (phaseRef === ref) {
          delete p.phaseModels[phase];
          touched = true;
        }
      }
    }
    if (touched) {
      projChanged = true;
      cleanedProjects.push(p.name || p.id);
    }
  }
  if (projChanged) {
    await saveProjects(projData);
    ctx.print(`(cleared stale references on project(s): ${cleanedProjects.join(', ')})`);
    ctx.noteReloadProject?.();
  }
  ctx.noteReloadModels?.();
}

async function showModel(ctx) {
  const { default: def } = await loadModels();
  // Effective default resolution mirrors resolveDefaultModel: the current
  // project's override (when set AND resolvable) wins over the global default.
  const getter = ctx.getCurrentProject || (async () => (await import('../../lib/config/home.js')).getCurrentProject());
  const project = await getter.call(ctx);
  const projRef = getProjectDefaultModelRef(project);
  const projCfg = projRef ? await resolveModelRef(projRef) : null;
  const effectiveRef = (projRef && projCfg) ? projRef : def;

  if (!effectiveRef) {
    ctx.print(`No default model configured. Use /model add then /model set-default.`);
    return;
  }
  ctx.print(`default = ${effectiveRef}`);
  if (project) {
    if (projRef && projCfg) {
      ctx.print(`  project: ${project.name} (project default, set via /model set-default current)`);
    } else if (projRef) {
      ctx.print(`  project: ${project.name} (project default ${projRef} is stale - unresolvable, falling back to the global default)`);
    } else {
      ctx.print(`  project: ${project.name} (no project default - using the global default)`);
    }
  }
  ctx.print(`  global: ${def || '(none)'}`);
  const cfg = (projRef && projCfg) ? projCfg : await resolveModelRef(def);
  if (!cfg) { ctx.print(`  (unable to resolve)`); return; }
  ctx.print(`  api: ${cfg.style}`);
  ctx.print(`  baseUrl: ${cfg.baseUrl || '(default)'}`);
  ctx.print(`  model: ${cfg.model}`);
  ctx.print(`  modelType: ${cfg.modelType || 'generic'}`);
  printModelOptions(ctx, cfg.modelOptions);
  // Display the STORED form: keeps the $APIKEY placeholder visible instead
  // of printing the provider's resolved (real) credential to the terminal.
  const mcp = await getModelMcpServers(effectiveRef, { resolve: false });
  if (mcp) printMcpServers(ctx, mcp);
  ctx.print(`  contextWindow: ${cfg.maxChars}`);
  ctx.print(`  reasoning: ${cfg.enableReasoning ? 'on' : 'off'}`);
  ctx.print(`  temperature: ${cfg.temperature}`);
}

/**
 * Render a model's feature options (--model-options) for /model list and show.
 * Values are strings/numbers/booleans; nested objects are JSON-stringified.
 */
function printModelOptions(ctx, modelOptions) {
  if (!modelOptions || typeof modelOptions !== 'object' || Object.keys(modelOptions).length === 0) return;
  const parts = Object.entries(modelOptions).map(([k, v]) => {
    const vs = (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v);
    return `${k}=${vs}`;
  });
  ctx.print(`    modelOptions: ${parts.join(' ')}`);
}

/**
 * Render the MCP servers attached to a model (written by
 * /model add-mcpserver) for /model list and /model show. No output for
 * models without servers.
 */
function printMcpServers(ctx, mcpServers) {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return;
  for (const s of mcpServers) {
    const opts = (s.options && typeof s.options === 'object') ? JSON.stringify(s.options) : '{}';
    ctx.print(`    mcpServer: ${s.name || '?'} (type=${s.type || '?'})`);
    ctx.print(`      options: ${opts}`);
  }
}

/**
 * /model add-mcpserver <provider>/<model-id> --type=TYPE --name=NAME [--options=JSON]
 *
 * Attach an MCP (Model Context Protocol) server configuration to an
 * EXISTING model entry, stored under that model's `mcpServers` array:
 *   [{ "type": "http", "name": "web-reader", "options": { url, headers } }]
 *
 * Scope guarantee: this command only ever APPENDS to the addressed model's
 * mcpServers array (or replaces the entry when the same --name is re-added).
 * It never creates providers/models and never modifies any other model
 * field. The referenced model must already exist (/model add).
 *
 * --type selects the server service type (http | stdio; only http is
 *   implemented today). --options is a JSON object whose shape depends on
 *   the type; http accepts { "url": string (required), "headers": {..} (optional) }.
 */
async function addMcpServer(rest, ctx) {
  // Resolve --options BEFORE generic flag parsing: the documented multi-line
  // form  --options=\n'{ ... }'  tokenizes to an empty-value '--options='
  // token followed by the quoted JSON as its own token (the tokenizer keeps
  // the quoted span's interior whitespace/newlines in that one token). Pick
  // up both that form and the inline --options=VALUE / '--options' VALUE forms.
  let optionsRaw;
  let optionsJsonIdx = -1;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--options') {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { optionsRaw = next; optionsJsonIdx = i + 1; }
      break;
    }
    if (t.startsWith('--options=')) {
      const v = t.slice('--options='.length);
      if (v !== '') optionsRaw = v;
      else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) { optionsRaw = next; optionsJsonIdx = i + 1; }
      }
      break;
    }
  }

  // Positional model ref: the first token that is not a flag, not a value
  // captured for a space-separated flag (--name x), and not the --options
  // JSON payload token.
  const usedValues = new Set();
  const refCandidates = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (i === optionsJsonIdx) continue;
    if (t.startsWith('--')) {
      const next = rest[i + 1];
      if (!t.includes('=') && next !== undefined && !next.startsWith('--')) usedValues.add(next);
      continue;
    }
    if (usedValues.has(t)) continue;
    refCandidates.push(t);
  }
  const ref = refCandidates.find(t => t.includes('/')) || refCandidates[0];

  const flags = parseFlags(rest);
  const typeRaw = typeof flags.type === 'string' ? flags.type : '';
  const nameRaw = typeof flags.name === 'string' ? flags.name.trim() : '';

  const usage = () => {
    ctx.print(`Usage: /model add-mcpserver <provider>/<model-id> --type=<${supportedMcpServerTypes().join('|')}> --name=<MCPSERVER_NAME>`);
    ctx.print(`                       [--options=<JSON>]`);
    ctx.print(``);
    ctx.print(`Attach an MCP server to an existing model (the model must already exist).`);
    ctx.print(`--type     MCP server service type (${supportedMcpServerTypes().join(', ')}; currently implemented: http)`);
    ctx.print(`--name     MCP server name (unique per model; re-adding the same name replaces it)`);
    ctx.print(`--options  JSON object, shape depends on --type. http supports:`);
    ctx.print(`           '{"url":"mcp_server_url","headers":{"Authorization":"Bearer $APIKEY"}}'`);
    ctx.print(`           $APIKEY (also ${'${APIKEY}'}) is substituted at use time with this model's`);
    ctx.print(`           provider --api-key, so the key never needs to be retyped here.`);
    ctx.print(``);
    ctx.print(`Example:`);
    ctx.print(`  /model add-mcpserver bigmodel2/glm-5.3[1m] --type=http --name=web-reader --options='`);
    ctx.print(`    {`);
    ctx.print(`      "url": "https://open.bigmodel.cn/api/mcp/web_reader/mcp",`);
    ctx.print(`      "headers": { "Authorization": "Bearer $APIKEY" }`);
    ctx.print(`    }'`);
  };

  const refSplit = ref ? splitModelRef(ref) : null;
  if (!refSplit || !typeRaw || !nameRaw) { usage(); return; }

  const type = normalizeMcpServerType(typeRaw);
  if (!type) {
    ctx.print(`Unknown MCP server type: ${typeRaw}`);
    ctx.print(`Supported types: ${supportedMcpServerTypes().join(', ')}`);
    return;
  }
  // normalizeMcpServerOptions reports stdio's "not implemented" here.
  const opt = normalizeMcpServerOptions(type, optionsRaw === undefined ? '{}' : optionsRaw);
  if (opt.error) {
    ctx.print(`Invalid --options: ${opt.error}`);
    return;
  }

  // Resolve the target model entry; never create providers or models here.
  const data = await loadModels();
  const prov = data.providers[refSplit.provider];
  const entry = (prov && Array.isArray(prov.models)) ? prov.models.find(m => m.id === refSplit.model) : null;
  if (!entry) {
    ctx.print(`Model not found: ${ref} (use /model add <provider> <model-id> first)`);
    return;
  }

  // Append (or replace same-named entry) on the model's mcpServers array.
  if (!Array.isArray(entry.mcpServers)) entry.mcpServers = [];
  const server = { type, name: nameRaw, options: opt.options };
  const existing = entry.mcpServers.findIndex(s => s && s.name === nameRaw);
  if (existing >= 0) entry.mcpServers[existing] = server;
  else entry.mcpServers.push(server);

  await saveModels(data);
  ctx.print(`MCP server added: ${nameRaw} (type=${type}) -> ${ref}`);
  if (JSON.stringify(server).includes('$APIKEY')) {
    ctx.print(`  ($APIKEY will be substituted with this provider's api key at use time)`);
  }
  ctx.noteReloadModels?.();
}

/**
 * Parse --key=value / --flag tokens into a flat object.
 * Values are always strings (or `true` for value-less flags). Boolean flags are
 * normalized later via parseBoolFlag so that "on"/"off"/"true"/"false"/"1"/"0"
 * all work.
 */
function parseFlags(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) {
        out[t.slice(2, eq)] = t.slice(eq + 1);
      } else {
        const key = t.slice(2);
        const next = tokens[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
      }
    }
  }
  return out;
}

/**
 * /model set-phase --phase=<name> <provider>/<model-id> [--clear]
 * Configure a per-phase model override for the CURRENT project. When set,
 * that phase uses the configured model instead of the current session model.
 * Defaults to the session model when unset (the default state).
 *
 * Currently supported phases: rewrite-query, request-assess, plan-review,
 * code-review.
 *   /model set-phase --phase=rewrite-query prov/model
 *   /model set-phase --phase=rewrite-query --clear
 *   /model set-phase --phase=request-assess prov/model
 *   /model set-phase --phase=plan-review prov/model
 *   /model set-phase --phase=code-review prov/model
 */
async function setPhaseModel(rest, ctx) {
  const flags = parseFlags(rest);
  // After parseFlags consumes the --phase=... and --clear tokens, the
  // remaining positional is the model ref (if any). Re-derive it from the raw
  // tokens so an order-independent UX works: take the first token that is
  // neither a flag nor a value captured for phase/clear.
  const usedValues = new Set([typeof flags.phase === 'string' ? flags.phase : '', typeof flags.clear === 'string' ? flags.clear : '']);
  const positional = rest.filter((t) => !t.startsWith('--') && !usedValues.has(t));
  const phaseRaw = flags.phase;
  const wantClear = parseBoolFlag(flags.clear === undefined ? false : flags.clear);

  if (!phaseRaw) {
    ctx.print(`Usage: /model set-phase --phase=<name> <provider>/<model-id> [--clear]`);
    ctx.print(`Supported phases: ${supportedPhaseNames().join(', ')}`);
    ctx.print(`Examples:`);
    ctx.print(`  /model set-phase --phase=rewrite-query openai-local/gpt-4o`);
    ctx.print(`  /model set-phase --phase=rewrite-query --clear`);
    ctx.print(`  /model set-phase --phase=request-assess openai-local/gpt-4o`);
    ctx.print(`  /model set-phase --phase=plan-review openai-local/gpt-4o`);
    ctx.print(`  /model set-phase --phase=code-review openai-local/gpt-4o`);
    return;
  }
  const phaseKey = normalizePhaseName(phaseRaw);
  if (!phaseKey) {
    ctx.print(`Unknown phase: ${phaseRaw}`);
    ctx.print(`Supported phases: ${supportedPhaseNames().join(', ')}`);
    return;
  }

  // Resolve the project this session is operating on. Falls back to the shared
  // global current for non-interactive callers (serve / one-shot), so the
  // command still works there.
  const getter = ctx.getCurrentProject || (async () => (await import('../../lib/config/home.js')).getCurrentProject());
  const cur = await getter.call(ctx);
  if (!cur) {
    ctx.print(`No current project. Run /project init or /project set current <id> first.`);
    return;
  }

  if (wantClear) {
    const updated = await clearPhaseModelRef(cur.id, phaseRaw);
    if (!updated) {
      ctx.print(`Failed to clear phase model (project or phase unknown).`);
      return;
    }
    ctx.print(`Cleared phase model for ${phaseRaw} on project ${cur.name}.`);
    ctx.print(`  (phase will now use the current session model)`);
    ctx.noteReloadProject?.();
    return;
  }

  const ref = positional[0];
  if (!ref) {
    ctx.print(`Usage: /model set-phase --phase=${phaseRaw} <provider>/<model-id> [--clear]`);
    return;
  }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const m = (prov.models || []).find(x => x.id === split.model);
  if (!m) { ctx.print(`Model not found: ${ref}`); return; }

  const updated = await setPhaseModelRef(cur.id, phaseRaw, ref);
  if (!updated) {
    ctx.print(`Failed to set phase model (project or phase unknown).`);
    return;
  }
  ctx.print(`Phase model set: ${phaseRaw} -> ${ref} (project: ${cur.name})`);
  ctx.noteReloadProject?.();
}

/** Normalize a reasoning flag value to a boolean. Accepts on/off/true/false/1/0. */
function parseBoolFlag(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'on' || s === 'true' || s === '1' || s === 'yes';
}
