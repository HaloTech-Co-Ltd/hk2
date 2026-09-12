/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. See the license file for
 * details.
 *
 *-------------------------------------------------------------------------*/

/**
 * /tool — view and configure the multimodal vision tool suite.
 *
 *   /tool list                        list the 8 vision tools + status
 *   /tool show <name>                 describe one tool (params, inputs)
 *   /tool enable <name>               re-enable a disabled tool
 *   /tool disable <name>              disable a tool for this install
 *   /tool set-model <provider>/<id>   set the suite-wide default vision model
 *                                      (must resolve multimodal:on)
 *   /tool set-model <tool> <p>/<id>   set ONE tool's own vision model
 *                                      (wins over the suite default for that
 *                                      tool only)
 *   /tool clear-model [tool]          drop the suite override, or one tool's
 *                                      override when a tool name is given
 *                                      (no arg keeps back-compat)
 *   /tool reset                       re-enable every disabled tool
 *
 * Settings live in ~/.hk2/tools.json (visionModelRef + toolModels +
 * disabled[]), written through withToolSettings (cross-process lock, same
 * discipline as withModels). Every model ref — suite-wide or per-tool — must
 * be a multimodal-capable type with --multimodal=on — validated at write
 * time against the resolved config and re-validated at every read (stale
 * refs silently fall back).
 */
import {
  loadModels,
  resolveModelRef,
  splitModelRef,
  loadToolSettings,
  clearToolVisionModelRef,
  clearToolModelRef,
  setToolEnabled,
  resetToolDisabled,
  modelTypeMultimodal,
  DEFAULT_MODEL_TYPE,
} from '../../lib/config/home.js';
import {
  VISION_TOOLS,
  VISION_TOOL_NAMES,
  visionToolByName,
  resolveVisionRuntime,
} from '../../lib/agent/vision_tools.js';

function printUsage(ctx) {
  ctx.print(`Usage: /tool <subcommand> [args]`);
  ctx.print(`View and configure the multimodal vision tool suite (8 tools).`);
  ctx.print(``);
  ctx.print(`Subcommands:`);
  ctx.print(`  list                        List the vision tools and their status`);
  ctx.print(`  show <name>                 Describe one tool (inputs and parameters)`);
  ctx.print(`  enable <name>               Re-enable a disabled tool`);
  ctx.print(`  disable <name>              Disable a tool (it disappears from the agent)`);
  ctx.print(`  set-model <provider>/<id>   Set the default multimodal model for the suite`);
  ctx.print(`  set-model <tool> <p>/<id>   Set ONE tool's own multimodal model (overrides the default)`);
  ctx.print(`  clear-model [tool]          Remove the suite override, or one tool's override`);
  ctx.print(`  reset                       Re-enable every disabled tool`);
  ctx.print(``);
  ctx.print(`The vision tools forward images/video to a DEDICATED multimodal model`);
  ctx.print(`and return its analysis as text — so any session model gains multimodal`);
  ctx.print(`capabilities. Each tool may use its own model; without a per-tool`);
  ctx.print(`override the suite default applies, then a multimodal session model.`);
  ctx.print(`Configure the model first:`);
  ctx.print(`  /model add bigmodel glm-5.3-flash --model-type=glm-5.3-flash --multimodal=on`);
  ctx.print(`  /tool set-model bigmodel/glm-5.3-flash`);
  ctx.print(`  /tool set-model video_analysis other/qwen-vl   (per-tool override)`);
}

/** Validate + resolve a model ref for set-model (shared by both forms). */
async function resolveRefOrPrint(ref, ctx) {
  const split = splitModelRef(ref);
  if (!split) { ctx.print(`Invalid ref: ${ref} (expected provider/model-id)`); return null; }
  const { providers } = await loadModels();
  const prov = providers[split.provider];
  if (!prov) { ctx.print(`Provider not found: ${split.provider}`); return null; }
  const m = (prov.models || []).find(x => x.id === split.model);
  if (!m) { ctx.print(`Model not found: ${ref}`); return null; }

  // Capability gate: entry flag AND model type must both declare multimodal.
  const modelType = typeof m.modelType === 'string' ? m.modelType : DEFAULT_MODEL_TYPE;
  if (m.multimodal !== true || modelTypeMultimodal(modelType) !== true) {
    ctx.print(`${ref} does not accept multimodal input.`);
    ctx.print(`Enable it first: /model set ${ref} --multimodal=on`);
    ctx.print(`(only multimodal-capable model types qualify — see /model types)`);
    return null;
  }
  const cfg = await resolveModelRef(ref);
  if (!cfg || cfg.multimodal !== true) {
    ctx.print(`${ref} resolved without multimodal capability; refusing.`);
    return null;
  }
  return cfg;
}

/** List every vision tool with enable/disable + short description. */
async function toolList(ctx) {
  const settings = await loadToolSettings().catch(() => ({ visionModelRef: null, toolModels: {}, disabled: [] }));
  const disabled = new Set(settings.disabled || []);
  const runtime = await resolveVisionRuntime({ modelCfg: ctx.modelCfg }).catch(() => null);
  const perToolCfgs = runtime?.perTool || {};

  ctx.print(`Multimodal vision tools (8):`);
  for (const t of VISION_TOOLS) {
    const flag = disabled.has(t.name) ? '✗ off' : '✓ on ';
    const media = t.media === 'video' ? 'video' : 'image';
    const override = settings.toolModels?.[t.name];
    ctx.print(`  ${flag}  ${t.name.padEnd(32)} [${media}]  ${t.snippet}`);
    if (override) {
      const ok = perToolCfgs[t.name] != null;
      ctx.print(`         ↳ own model: ${override}${ok ? '' : '  (unresolvable as multimodal — falls back to the suite default / session model; re-run /tool set-model)'}`);
    }
  }
  ctx.print(``);
  if (settings.visionModelRef) {
    const ok = runtime?.source === 'tools';
    ctx.print(`Vision model: ${settings.visionModelRef}${ok ? '' : '  (unresolvable as multimodal — re-run /tool set-model)'}`);
  } else if (runtime?.source === 'session') {
    ctx.print(`Vision model: (none configured — using the session model ${ctx.modelCfg?.ref || '?'} which has --multimodal=on)`);
  } else {
    const covered = Object.values(settings.toolModels || {}).length;
    if (covered > 0) {
      ctx.print(`Vision model: (no suite default — ${covered} tool(s) use their own per-tool model; the rest are NOT available)`);
    } else {
      ctx.print(`Vision model: (none) — the tools are NOT available to the agent.`);
      ctx.print(`  Configure one: /model add bigmodel glm-5.3-flash --model-type=glm-5.3-flash --multimodal=on`);
      ctx.print(`                /tool set-model bigmodel/glm-5.3-flash`);
    }
  }
  if (disabled.size > 0) {
    ctx.print(`Disabled tools: ${[...disabled].join(', ')}  (re-enable with /tool enable <name> or /tool reset)`);
  }
}

/** Show one tool's inputs and parameters. */
async function toolShow(rest, ctx) {
  const name = rest[0];
  if (!name) { ctx.print(`Usage: /tool show <name>  (names: /tool list)`); return; }
  const t = visionToolByName(name);
  if (!t) {
    ctx.print(`Unknown tool: ${name}`);
    ctx.print(`Known tools: ${VISION_TOOL_NAMES.join(', ')}`);
    return;
  }
  const settings = await loadToolSettings().catch(() => ({ disabled: [], toolModels: {} }));
  const disabled = new Set(settings.disabled || []);
  ctx.print(`${t.name}${disabled.has(t.name) ? '  (disabled)' : ''}`);
  ctx.print(`  ${t.snippet}`);
  ctx.print(`  media: ${t.media}`);
  const own = settings.toolModels?.[t.name];
  if (own) ctx.print(`  own model: ${own}  (per-tool override)`);
  for (const i of t.inputs) {
    ctx.print(`  input:  ${i.arg} — ${i.label}`);
  }
  const props = t.parameters?.properties || {};
  for (const [k, v] of Object.entries(props)) {
    if (t.inputs.some(i => i.arg === k)) continue;
    const enumStr = Array.isArray(v.enum) ? `  enum: ${v.enum.join(' | ')}` : '';
    ctx.print(`  arg:    ${k}${v.description ? ` — ${v.description}` : ''}${enumStr}`);
  }
}

/** /tool set-model <provider>/<model-id>  |  /tool set-model <tool> <provider>/<model-id> */
async function toolSetModel(rest, ctx) {
  // Overload resolution: when the FIRST positional names a known vision tool,
  // the second positional is the model ref (per-tool form); otherwise the
  // first positional is the ref itself (suite-wide form).
  const firstIsTool = visionToolByName(rest[0] || '') != null;
  const toolName = firstIsTool ? rest[0] : null;
  const ref = firstIsTool ? rest[1] : rest[0];

  if (!ref) {
    ctx.print(`Usage: /tool set-model <provider>/<model-id>`);
    ctx.print(`       /tool set-model <tool> <provider>/<model-id>   (per-tool override)`);
    ctx.print(`The model must be multimodal-capable with --multimodal=on, e.g.:`);
    ctx.print(`  /model add bigmodel glm-5.3-flash --model-type=glm-5.3-flash --multimodal=on`);
    ctx.print(`  /tool set-model bigmodel/glm-5.3-flash`);
    ctx.print(`  /tool set-model video_analysis other/qwen-vl`);
    return;
  }
  if (firstIsTool && rest[2]) {
    ctx.print(`Unexpected extra argument: ${rest[2]}`);
    ctx.print(`Usage: /tool set-model <tool> <provider>/<model-id>`);
    return;
  }
  const cfg = await resolveRefOrPrint(ref, ctx);
  if (!cfg) return;

  if (toolName) {
    const { setToolModelRef } = await import('../../lib/config/home.js');
    const out = await setToolModelRef(toolName, ref, cfg);
    if (out?.error) { ctx.print(`Failed: ${out.error}`); return; }
    ctx.print(`Model for ${toolName}: ${ref}`);
    ctx.print(`${toolName} now uses ${ref} internally; other tools keep the suite default / session fallback.`);
    return;
  }

  const { setToolVisionModelRef } = await import('../../lib/config/home.js');
  const out = await setToolVisionModelRef(ref, cfg);
  if (out?.error) { ctx.print(`Failed: ${out.error}`); return; }
  ctx.print(`Vision model set: ${ref}`);
  ctx.print(`The vision tools now use ${ref} internally (any session model gains multimodal analysis).`);
}

/** /tool clear-model [tool] */
async function toolClearModel(rest, ctx) {
  if (rest[0]) {
    const t = visionToolByName(rest[0]);
    if (!t) {
      ctx.print(`Unknown tool: ${rest[0]}`);
      ctx.print(`Known tools: ${VISION_TOOL_NAMES.join(', ')}`);
      return;
    }
    const out = await clearToolModelRef(rest[0]);
    if (out?.error) { ctx.print(`Failed: ${out.error}`); return; }
    if (out?.had) {
      ctx.print(`Per-tool model override removed for ${rest[0]}.`);
      ctx.print(`It falls back to the suite default, then a multimodal session model.`);
    } else {
      ctx.print(`No per-tool model override was configured for ${rest[0]}.`);
    }
    return;
  }
  const out = await clearToolVisionModelRef();
  if (out?.error) { ctx.print(`Failed: ${out.error}`); return; }
  if (out?.had) {
    ctx.print(`Vision model override removed.`);
    ctx.print(`The tools fall back to per-tool overrides (if any), then the session`);
    ctx.print(`model when it has --multimodal=on; otherwise they are not registered.`);
  } else {
    ctx.print(`No vision model override was configured.`);
    ctx.print(`(To remove a per-tool override: /tool clear-model <tool>)`);
  }
}

/** /tool enable|disable <name> */
async function toolToggle(rest, ctx, enabled) {
  const name = rest[0];
  const verb = enabled ? 'enable' : 'disable';
  if (!name) { ctx.print(`Usage: /tool ${verb} <name>  (names: /tool list)`); return; }
  const out = await setToolEnabled(name, enabled, VISION_TOOL_NAMES);
  if (out?.error) {
    ctx.print(`Failed: ${out.error}`);
    ctx.print(`Known tools: ${VISION_TOOL_NAMES.join(', ')}`);
    return;
  }
  ctx.print(`${name} ${enabled ? 'enabled' : 'disabled'}${enabled ? '' : ' — it disappears from the agent tool list on the next turn'}.`);
}

/** /tool reset */
async function toolReset(ctx) {
  const out = await resetToolDisabled();
  if (out?.error) { ctx.print(`Failed: ${out.error}`); return; }
  if (out?.had > 0) {
    ctx.print(`Re-enabled ${out.had} tool(s).`);
  } else {
    ctx.print(`No tools were disabled.`);
  }
}

export async function cmdTool(args, ctx) {
  const rest = (args || []).map(a => String(a || '')).filter(Boolean);
  const sub = rest[0];
  const restArgs = rest.slice(1);

  switch (sub) {
    case undefined:
    case 'help':
      printUsage(ctx);
      return;
    case 'list':
      await toolList(ctx);
      return;
    case 'show':
      await toolShow(restArgs, ctx);
      return;
    case 'enable':
      await toolToggle(restArgs, ctx, true);
      return;
    case 'disable':
      await toolToggle(restArgs, ctx, false);
      return;
    case 'set-model':
      await toolSetModel(restArgs, ctx);
      return;
    case 'clear-model':
      await toolClearModel(restArgs, ctx);
      return;
    case 'reset':
      await toolReset(ctx);
      return;
    default:
      ctx.print(`Unknown subcommand: ${sub}`);
      printUsage(ctx);
  }
}
