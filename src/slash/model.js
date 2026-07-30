/**
 * /model command family — manage ~/.hk2/models.json.
 *
 * Usage:
 *   /model list                          List all providers / models
 *   /model use <provider>/<model-id>     Set default
 *   /model add <provider> <model-id> [--api=openai|anthropic] [--base-url=...] [--api-key=...] [--reasoning] [--context-window=N] [--max-tokens=N] [--temperature=N] [--name=...]
 *   /model del <provider>/<model-id>
 *   /model show                          Show current default
 */
import {
  loadModels, saveModels, splitModelRef, resolveModelRef,
} from '../../lib/config/home.js';

export async function cmdModel(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'list': case 'ls': return listModels(ctx);
    case 'use': return useModel(rest, ctx);
    case 'add': return addModel(rest, ctx);
    case 'del': case 'rm': return delModel(rest, ctx);
    case 'show': return showModel(ctx);
    default:
      ctx.print(`/model subcommands: list | use | add | del | show`);
      ctx.print(`Examples:`);
      ctx.print(`  /model list`);
      ctx.print(`  /model add openai-local gpt-4o --api=openai --base-url=http://... --api-key=sk-... --context-window=128000`);
      ctx.print(`  /model use openai-local/gpt-4o`);
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

async function useModel(rest, ctx) {
  const ref = rest[0];
  if (!ref) { ctx.print(`Usage: /model use <provider>/<model-id>`); return; }
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
  if (flags.reasoning !== undefined) entry.reasoning = !!flags.reasoning;
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
  if (!def) { ctx.print(`No default model configured. Use /model add then /model use.`); return; }
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
