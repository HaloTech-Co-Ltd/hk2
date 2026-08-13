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
 *   /model set <provider>/<model-id> [--name=...] [--api=...] [--base-url=...] [--api-key=...]
 *                  [--reasoning=on|off] [--context-window=N] [--max-tokens=N] [--temperature=N]
 *                                                  Modify a model's persisted settings
 *   /model add <provider> <model-id> [--flags]     Add a new model (creates provider if needed)
 *   /model del <provider>/<model-id>               Delete a model
 *   /model show                                    Show current default
 */
import {
  loadModels, saveModels, splitModelRef, resolveModelRef,
  normalizePhaseName, supportedPhaseNames,
  setPhaseModelRef, clearPhaseModelRef,
} from '../../lib/config/home.js';

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
    case 'show': return showModel(ctx);
    default:
      ctx.print(`/model subcommands: list | use | set-default | set | set-phase | add | del | show`);
      ctx.print(`Examples:`);
      ctx.print(`  /model list`);
      ctx.print(`  /model add openai-local gpt-4o --api=openai --base-url=http://... --api-key=sk-... --context-window=128000`);
      ctx.print(`  /model use openai-local/gpt-4o                          (this session only)`);
      ctx.print(`  /model set-default openai-local/gpt-4o                  (global default, persisted)`);
      ctx.print(`  /model set openai-local/gpt-4o --temperature=0.5 --max-tokens=8192`);
      ctx.print(`  /model set-phase --phase=rewrite-query openai-local/gpt-4o   (per-project, rewrite phase)`);
      ctx.print(`  /model set-phase --phase=plan-review openai-local/gpt-4o     (per-project, plan-review phase)`);
      ctx.print(`  /model del openai-local/gpt-4o`);
  }
}

async function listModels(ctx) {
  const { providers, default: def } = await loadModels();
  const names = Object.keys(providers);
  if (names.length === 0) {
    ctx.print(`(empty. Use /model add <provider> <model-id> to add one)`);
    return;
  }
  ctx.print(`Models (default: ${def || '(none)'})`);
  for (const pname of names) {
    const p = providers[pname];
    ctx.print(``);
    ctx.print(`[${pname}]  api=${p.api || 'openai'}  baseUrl=${p.baseUrl || '(default)'}`);
    for (const m of (p.models || [])) {
      const ref = `${pname}/${m.id}`;
      const marker = ref === def ? '* ' : '  ';
      ctx.print(`${marker}${m.id.padEnd(28)} ${m.name || ''}`);
      ctx.print(`    contextWindow=${m.contextWindow || '?'} maxTokens=${m.maxTokens || '?'} reasoning=${m.reasoning ? 'on' : 'off'} temperature=${m.temperature ?? 0.2}`);
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
 * Persist the global default model in models.json and signal the REPL to reload.
 */
async function setDefaultModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) { ctx.print(`Usage: /model set-default <provider>/<model-id>`); return; }
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
 * /model set <provider>/<model-id> [--flags]
 * Modify persisted settings of an existing model (and its provider). The model
 * must already exist (use /model add to create). Only the flags you pass are
 * applied; omitted flags keep their current value.
 *
 * Flags:
 *   --name=NAME
 *   --api=openai|anthropic          (provider-level)
 *   --base-url=URL                  (provider-level)
 *   --api-key=KEY                   (provider-level)
 *   --reasoning=on|off
 *   --context-window=N
 *   --max-tokens=N
 *   --temperature=N
 */
async function setModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) {
    ctx.print(`Usage: /model set <provider>/<model-id> [--name=NAME] [--api=openai|anthropic] [--base-url=URL] [--api-key=KEY]`);
    ctx.print(`                        [--reasoning=on|off] [--context-window=N] [--max-tokens=N] [--temperature=N]`);
    return;
  }
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return; }
  const flags = parseFlags(rest.slice(1));

  const data = await loadModels();
  const prov = data.providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return; }
  const entry = (prov.models || []).find(m => m.id === split.model);
  if (!entry) { ctx.print(`Model not found: ${ref} (use /model add to create it first)`); return; }

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

  await saveModels(data);
  ctx.print(`Updated: ${ref}`);
  ctx.print(`  contextWindow=${entry.contextWindow ?? '?'} maxTokens=${entry.maxTokens ?? '?'} reasoning=${entry.reasoning ? 'on' : 'off'} temperature=${entry.temperature ?? 0.2}`);
  // If the session is currently using this model, hot-swap it so the change
  // takes effect immediately without a full reload.
  if (typeof ctx.setModel === 'function' && ctx.modelCfg?.ref === ref) {
    const cfg = await resolveModelRef(ref);
    if (cfg) ctx.setModel(cfg);
  }
  ctx.noteReloadModels?.();
}

async function addModel(rest, ctx) {
  if (rest.length < 2) {
    ctx.print(`Usage: /model add <provider> <model-id> [--api=openai|anthropic] [--base-url=URL] [--api-key=KEY]`);
    ctx.print(`                        [--reasoning] [--context-window=N] [--max-tokens=N] [--temperature=N] [--name=NAME]`);
    return;
  }
  const providerName = rest[0];
  const modelId = rest[1];
  const flags = parseFlags(rest.slice(2));

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
  else if (entry.reasoning === undefined) entry.reasoning = false;

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
  ctx.noteReloadModels?.();
}

async function showModel(ctx) {
  const { default: def } = await loadModels();
  if (!def) { ctx.print(`No default model configured. Use /model add then /model set-default.`); return; }
  ctx.print(`default = ${def}`);
  const cfg = await resolveModelRef(def);
  if (!cfg) { ctx.print(`(unable to resolve)`); return; }
  ctx.print(`  api: ${cfg.style}`);
  ctx.print(`  baseUrl: ${cfg.baseUrl || '(default)'}`);
  ctx.print(`  model: ${cfg.model}`);
  ctx.print(`  contextWindow: ${cfg.maxChars}`);
  ctx.print(`  reasoning: ${cfg.enableReasoning ? 'on' : 'off'}`);
  ctx.print(`  temperature: ${cfg.temperature}`);
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
 * Currently supported phases: rewrite-query, plan-review.
 *   /model set-phase --phase=rewrite-query prov/model
 *   /model set-phase --phase=rewrite-query --clear
 *   /model set-phase --phase=plan-review prov/model
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
    ctx.print(`  /model set-phase --phase=plan-review openai-local/gpt-4o`);
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
