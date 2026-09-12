/*-------------------------------------------------------------------------
 *
 * /tool slash command regression tests.
 *
 * Feature under test:
 *   1. registration & help: /tool in SLASH_COMMANDS, HELP_TEXT.tool lists
 *      every subcommand the dispatcher routes, completions cover the family;
 *   2. dispatch: list / show / enable / disable / set-model / clear-model /
 *      reset behaviors, error paths (unknown tool, unknown provider,
 *      non-multimodal model, invalid ref);
 *   3. persistence: tools.json reflects enable/disable + visionModelRef and
 *      survives an isolated config layer reload;
 *   4. no-mutation-on-failure: a rejected set-model leaves tools.json
 *      byte-identical.
 *
 * Run:  node --test test/tool_command.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test, before } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels, loadToolSettings,
} from '../lib/config/home.js';
import { dispatchSlash } from '../src/slash/index.js';
import { SLASH_COMMANDS } from '../src/slash/index.js';
import { HELP_TEXT, renderHelp } from '../src/slash/help.js';
import { slashCompletions, allSlashCompletionLabels } from '../src/slash/index.js';
import { createSession, buildCtx } from '../src/commands/interactive.js';

function makeCtx(modelCfg = null) {
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(String(t));
  // modelCfg is a getter-only derived property on the ctx — inject the test
  // value via a property definition when a session model is simulated.
  if (modelCfg !== null) {
    Object.defineProperty(ctx, 'modelCfg', { value: modelCfg, configurable: true });
  }
  return { ctx, prints, session };
}

async function seedModels() {
  await saveModels({ providers: {
    bigmodel: {
      api: 'openai',
      baseUrl: 'http://localhost:9/v1',
      apiKey: 'sk-test',
      models: [
        { id: 'glm-5.3-flash', name: 'glm-5.3-flash', modelType: 'glm-5.3-flash', multimodal: true, contextWindow: 131072 },
        { id: 'plain', name: 'plain' },
      ],
    },
  }, default: null });
}

before(async () => {
  await ensureHome();
  await seedModels();
});

// -- 1. registration & help --------------------------------------------------

test('registration: /tool registered with a description', () => {
  const cmd = SLASH_COMMANDS.find(c => c.name === '/tool');
  assert.ok(cmd, '/tool registered');
  assert.ok(typeof cmd.handler === 'function');
  assert.ok(cmd.description.length > 0);
});

test('help: HELP_TEXT.tool lists every routed subcommand', () => {
  const text = HELP_TEXT.tool.join('\n');
  for (const sub of ['list', 'show', 'enable', 'disable', 'set-model', 'clear-model', 'reset']) {
    assert.ok(text.includes(sub), `HELP_TEXT.tool must mention "${sub}"`);
  }
  assert.ok(renderHelp('tool'), 'renderHelp(tool) resolves');
});

test('help: the 8 vision tool names are documented', () => {
  const text = HELP_TEXT.tool.join('\n');
  for (const n of ['ui_to_artifact', 'extract_text_from_screenshot', 'diagnose_error_screenshot',
    'understand_technical_diagram', 'analyze_data_visualization', 'ui_diff_check',
    'image_analysis', 'video_analysis']) {
    assert.ok(text.includes(n), `HELP_TEXT.tool must mention tool "${n}"`);
  }
});

test('completion: /tool family completes subcommands and data slots', () => {
  const labels = allSlashCompletionLabels();
  assert.ok(labels.includes('/tool'));
  assert.ok(labels.includes('/tool list'), 'subcommands derived from HELP_TEXT');
  // family subcommand completion
  const { items } = slashCompletions('/tool se');
  const got = items.map(i => i.label);
  assert.ok(got.includes('/tool set-model'), `got ${got}`);
  // model-ref dynamic slot for set-model
  const slot = slashCompletions('/tool set-model ');
  assert.equal(slot.replaceFrom, '/tool set-model '.length);
  // tool-name dynamic slot for show/enable/disable
  const nameSlot = slashCompletions('/tool disable ');
  assert.ok(nameSlot.replaceFrom > 0);
});

test('dispatch: /tool with no args prints usage', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool', ctx);
  assert.ok(prints.join('\n').includes('Usage: /tool'));
});

test('dispatch: unknown subcommand falls back to usage', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool frobnicate', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('Unknown subcommand: frobnicate'));
  assert.ok(text.includes('Usage: /tool'));
});

// -- 2. behaviors --------------------------------------------------------------

test('list: shows the 8 tools and the unconfigured state', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool list', ctx);
  const text = prints.join('\n');
  for (const n of ['ui_to_artifact', 'video_analysis']) assert.ok(text.includes(n));
  assert.ok(text.includes('Vision model'), 'vision model line present');
  assert.ok(!text.includes('✗'), 'no disabled tools yet');
});

test('show: describes one tool; unknown tool is an error', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool show ui_diff_check', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('ui_diff_check'));
  assert.ok(text.includes('design_path'));
  assert.ok(text.includes('implementation_path'));

  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool show nope', c2);
  assert.ok(p2.join('\n').includes('Unknown tool: nope'));
});

test('disable/enable/reset: state transitions with persistence', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool disable video_analysis', ctx);
  assert.ok(prints.join('\n').includes('video_analysis disabled'));

  let s = await loadToolSettings();
  assert.deepEqual(s.disabled, ['video_analysis']);

  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool list', c2);
  assert.ok(p2.join('\n').includes('✗ off'), 'list shows the disabled state');

  const { ctx: c3 } = makeCtx();
  await dispatchSlash('/tool enable video_analysis', c3);
  s = await loadToolSettings();
  assert.deepEqual(s.disabled, []);

  // disable two, then reset re-enables both
  const { ctx: c4 } = makeCtx();
  await dispatchSlash('/tool disable image_analysis', c4);
  const { ctx: c5 } = makeCtx();
  await dispatchSlash('/tool disable ui_diff_check', c5);
  const { ctx: c6, prints: p6 } = makeCtx();
  await dispatchSlash('/tool reset', c6);
  assert.ok(p6.join('\n').includes('Re-enabled 2 tool(s)'));
  s = await loadToolSettings();
  assert.deepEqual(s.disabled, []);
});

test('disable: unknown tool name rejected, nothing persisted', async () => {
  const before = JSON.stringify(await loadToolSettings());
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool disable not_a_tool', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('unknown tool: not_a_tool'));
  assert.ok(text.includes('video_analysis'), 'known-tools hint printed');
  assert.equal(JSON.stringify(await loadToolSettings()), before);
});

test('set-model: happy path persists visionModelRef', async () => {
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/glm-5.3-flash', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('Vision model set: bigmodel/glm-5.3-flash'));
  const s = await loadToolSettings();
  assert.equal(s.visionModelRef, 'bigmodel/glm-5.3-flash');

  // list now reports the configured model
  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool list', c2);
  assert.ok(p2.join('\n').includes('bigmodel/glm-5.3-flash'));
});

test('set-model: non-multimodal model rejected without persisting', async () => {
  const before = JSON.stringify(await loadToolSettings());
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/plain', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('does not accept multimodal input'));
  assert.ok(text.includes('--multimodal=on'), 'fix hint present');
  assert.equal(JSON.stringify(await loadToolSettings()), before);
});

test('set-model: unknown provider / model / invalid ref', async () => {
  const { ctx: c1, prints: p1 } = makeCtx();
  await dispatchSlash('/tool set-model nope/x', c1);
  assert.ok(p1.join('\n').includes('Provider not found: nope'));

  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/gone', c2);
  assert.ok(p2.join('\n').includes('Model not found'));

  const { ctx: c3, prints: p3 } = makeCtx();
  await dispatchSlash('/tool set-model badformat', c3);
  assert.ok(p3.join('\n').includes('Invalid ref'));

  const { ctx: c4, prints: p4 } = makeCtx();
  await dispatchSlash('/tool set-model', c4);
  assert.ok(p4.join('\n').includes('Usage: /tool set-model'));
});

test('clear-model: removes the override and reports fallback semantics', async () => {
  const { ctx: c1 } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/glm-5.3-flash', c1);
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool clear-model', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('removed'));
  assert.equal((await loadToolSettings()).visionModelRef, null);

  // second clear is a no-op notice
  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool clear-model', c2);
  assert.ok(p2.join('\n').includes('No vision model override'));
});

test('list: session-model fallback surfaced when no override but multimodal session model', async () => {
  const { ctx, prints } = makeCtx({ ref: 'bigmodel/glm-5.3-flash', multimodal: true });
  await dispatchSlash('/tool list', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('session model'), 'fallback line present');
  assert.ok(text.includes('bigmodel/glm-5.3-flash'));
});

// -- per-tool model overrides ----------------------------------------------

test('set-model <tool> <ref>: persists toolModels and reports the scope', async () => {
  const { ctx: c0 } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/glm-5.3-flash', c0);
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool set-model video_analysis bigmodel/glm-5.3-flash', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('Model for video_analysis: bigmodel/glm-5.3-flash'), text);
  const s = await loadToolSettings();
  assert.equal(s.toolModels.video_analysis, 'bigmodel/glm-5.3-flash');
  assert.equal(s.visionModelRef, 'bigmodel/glm-5.3-flash', 'suite default untouched');

  // list surfaces the per-tool override line
  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool list', c2);
  assert.ok(p2.join('\n').includes('own model: bigmodel/glm-5.3-flash'));

  // show surfaces it too
  const { ctx: c3, prints: p3 } = makeCtx();
  await dispatchSlash('/tool show video_analysis', c3);
  assert.ok(p3.join('\n').includes('own model'));
});

test('set-model <tool> <ref>: non-multimodal model rejected without persisting', async () => {
  const before = JSON.stringify(await loadToolSettings());
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool set-model image_analysis bigmodel/plain', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('does not accept multimodal input'));
  assert.equal(JSON.stringify(await loadToolSettings()), before);
});

test('set-model <tool> <ref>: unknown ref / extra arg / usage errors', async () => {
  const { ctx: c1, prints: p1 } = makeCtx();
  await dispatchSlash('/tool set-model video_analysis nope/x', c1);
  assert.ok(p1.join('\n').includes('Provider not found: nope'));

  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool set-model video_analysis bigmodel/glm-5.3-flash extra', c2);
  assert.ok(p2.join('\n').includes('Unexpected extra argument'));

  const { ctx: c3, prints: p3 } = makeCtx();
  await dispatchSlash('/tool set-model video_analysis', c3);
  assert.ok(p3.join('\n').includes('Usage: /tool set-model'));
});

test('clear-model <tool>: removes one override; unknown tool rejected', async () => {
  const { ctx: c0 } = makeCtx();
  await dispatchSlash('/tool set-model video_analysis bigmodel/glm-5.3-flash', c0);
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool clear-model video_analysis', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('Per-tool model override removed for video_analysis'));
  assert.equal((await loadToolSettings()).toolModels.video_analysis, undefined);

  const { ctx: c2 } = makeCtx();
  await dispatchSlash('/tool clear-model video_analysis', c2);
  assert.equal((await loadToolSettings()).toolModels.video_analysis, undefined);

  const { ctx: c3, prints: p3 } = makeCtx();
  await dispatchSlash('/tool clear-model not_a_tool', c3);
  assert.ok(p3.join('\n').includes('Unknown tool: not_a_tool'));
});

test('clear-model (no arg): keeps back-compat and points at the per-tool form', async () => {
  const { ctx: c0 } = makeCtx();
  await dispatchSlash('/tool set-model bigmodel/glm-5.3-flash', c0);
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/tool clear-model', ctx);
  const text = prints.join('\n');
  assert.ok(text.includes('removed'));
  assert.equal((await loadToolSettings()).visionModelRef, null);
  const { ctx: c2, prints: p2 } = makeCtx();
  await dispatchSlash('/tool clear-model', c2);
  assert.ok(p2.join('\n').includes('/tool clear-model <tool>'));
});
