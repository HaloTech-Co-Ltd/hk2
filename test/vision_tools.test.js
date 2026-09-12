/*-------------------------------------------------------------------------
 *
 * Multimodal vision tool suite regression tests.
 *
 * Feature under test (8 vision tools + /tool configuration):
 *   1. registry shape: 8 tools, unique names, media classes, JSON schemas;
 *   2. resolveVisionRuntime: tools.json visionModelRef (validated) →
 *      session multimodal model → null;
 *   3. runVisionTool argument validation: missing args, wrong media class,
 *      unknown extension, local video 8 MB cap, no-vision-model error hint;
 *   4. buildVisionTools: registered only with a resolved runtime, disabled
 *      tools excluded, tool objects carry parameters + execute;
 *   5. end-to-end with a stubbed LLMClient: image call assembles content
 *      blocks (image_url data URL) and returns the model's text.
 *
 * Run:  node --test test/vision_tools.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureHome, loadModels, saveModels, loadToolSettings,
  setToolVisionModelRef, clearToolVisionModelRef,
  setToolModelRef, clearToolModelRef, resolveToolModels,
  setToolEnabled, resetToolDisabled, resolveVisionModel,
} from '../lib/config/home.js';
import {
  VISION_TOOLS, VISION_TOOL_NAMES, visionToolByName,
  resolveVisionRuntime, buildVisionTools, runVisionTool,
  MAX_VIDEO_TOOL_BYTES,
} from '../lib/agent/vision_tools.js';
import LLMClient from '../lib/llm/client.js';
import { buildTools } from '../lib/agent/tools.js';

const HOME = process.env.HK2_HOME;

before(async () => {
  await ensureHome();
  await saveModels({ providers: {
    prov: {
      api: 'openai',
      baseUrl: 'http://localhost:9/v1',
      apiKey: 'sk-test',
      models: [
        { id: 'mm', name: 'mm', modelType: 'glm-5.3-flash', multimodal: true, contextWindow: 131072 },
        { id: 'mm2', name: 'mm2', modelType: 'glm-5.3-flash', multimodal: true, contextWindow: 131072 },
        { id: 'text-only', name: 'text-only' },
      ],
    },
  }, default: null });
});

// -- 1. registry shape ----------------------------------------------------

test('registry: exactly the 8 required tools, unique names', () => {
  assert.equal(VISION_TOOLS.length, 8);
  assert.equal(new Set(VISION_TOOL_NAMES).size, 8);
  const expected = ['ui_to_artifact', 'extract_text_from_screenshot',
    'diagnose_error_screenshot', 'understand_technical_diagram',
    'analyze_data_visualization', 'ui_diff_check', 'image_analysis',
    'video_analysis'];
  for (const n of expected) assert.ok(visionToolByName(n), `missing ${n}`);
  assert.equal(visionToolByName('nope'), null);
});

test('registry: media classes and required input args', () => {
  for (const t of VISION_TOOLS) {
    assert.ok(t.media === 'image' || t.media === 'video', `${t.name} media`);
    assert.ok(Array.isArray(t.inputs) && t.inputs.length >= 1, `${t.name} inputs`);
    assert.ok(t.parameters && t.parameters.type === 'object', `${t.name} schema`);
    for (const i of t.inputs) {
      assert.ok(t.parameters.required.includes(i.arg), `${t.name}.${i.arg} required`);
    }
  }
  assert.equal(visionToolByName('video_analysis').media, 'video');
  assert.equal(visionToolByName('ui_diff_check').inputs.length, 2);
});

// -- 2. runtime resolution --------------------------------------------------

test('resolveVisionRuntime: no vision model, non-multimodal session → null', async () => {
  await clearToolVisionModelRef();
  const rt = await resolveVisionRuntime({ modelCfg: { ref: 'prov/text-only', multimodal: false } });
  assert.equal(rt, null);
});

test('resolveVisionRuntime: falls back to a multimodal session model', async () => {
  await clearToolVisionModelRef();
  const rt = await resolveVisionRuntime({ modelCfg: { ref: 'prov/mm', multimodal: true, style: 'openai' } });
  assert.equal(rt.source, 'session');
  assert.equal(rt.cfg.ref, 'prov/mm');
});

test('resolveVisionRuntime: tools.json override wins over the session model', async () => {
  const { resolveModelRef } = await import('../lib/config/home.js');
  const cfg = await resolveModelRef('prov/mm');
  await setToolVisionModelRef('prov/mm', cfg);
  const rt = await resolveVisionRuntime({ modelCfg: { ref: 'prov/text-only', multimodal: false } });
  assert.equal(rt.source, 'tools');
  assert.equal(rt.cfg.ref, 'prov/mm');
  await clearToolVisionModelRef();
});

test('config layer: non-multimodal ref refused by setToolVisionModelRef', async () => {
  const bad = await setToolVisionModelRef('prov/text-only', { ref: 'prov/text-only' });
  assert.ok(bad.error);
  const bad2 = await setToolVisionModelRef('prov/text-only', null);
  assert.ok(bad2.error);
  // Nothing was persisted.
  const s = await loadToolSettings();
  assert.equal(s.visionModelRef, null);
});

test('config layer: stale stored ref resolves to null, never throws', async () => {
  const { withToolSettings } = await import('../lib/config/home.js');
  await withToolSettings((d) => { d.visionModelRef = 'prov/gone'; });
  assert.equal(await resolveVisionModel(), null);
  const rt = await resolveVisionRuntime({ modelCfg: null });
  assert.equal(rt, null);
  await clearToolVisionModelRef();
});

// -- 2b. per-tool model resolution ------------------------------------------

test('per-tool: setToolModelRef persists toolModels and validates multimodal', async () => {
  await clearToolModelRef();
  const { resolveModelRef } = await import('../lib/config/home.js');
  const cfg = await resolveModelRef('prov/mm2');
  const bad = await setToolModelRef('video_analysis', 'prov/text-only', { ref: 'prov/text-only' });
  assert.ok(bad.error);
  const bad2 = await setToolModelRef('video_analysis', 'prov/mm2', null);
  assert.ok(bad2.error);
  let s = await loadToolSettings();
  assert.deepEqual(s.toolModels, {});

  const ok = await setToolModelRef('video_analysis', 'prov/mm2', cfg);
  assert.equal(ok.ok, true);
  s = await loadToolSettings();
  assert.equal(s.toolModels.video_analysis, 'prov/mm2');

  // resolveToolModels drops stale / non-multimodal entries silently.
  const { withToolSettings } = await import('../lib/config/home.js');
  await withToolSettings((d) => { d.toolModels.image_analysis = 'prov/gone'; });
  const resolved = await resolveToolModels();
  assert.equal(resolved.video_analysis.cfg.ref, 'prov/mm2');
  assert.equal(resolved.video_analysis.source, 'tools');
  assert.equal(resolved.image_analysis, undefined);

  // clear one tool's override; the rest stay.
  const cleared = await clearToolModelRef('video_analysis');
  assert.equal(cleared.had, true);
  s = await loadToolSettings();
  assert.equal(s.toolModels.video_analysis, undefined);
  assert.equal(s.toolModels.image_analysis, 'prov/gone');
  await clearToolModelRef(); // clear all
  s = await loadToolSettings();
  assert.deepEqual(s.toolModels, {});
});

test('per-tool: resolveVisionRuntime returns perTool and the override wins for its tool', async () => {
  await clearToolVisionModelRef();
  await clearToolModelRef();
  const { resolveModelRef, withToolSettings } = await import('../lib/config/home.js');
  const cfg2 = await resolveModelRef('prov/mm2');
  await setToolModelRef('video_analysis', 'prov/mm2', cfg2);
  // Suite default (mm) + session text-only model: per-tool must win for
  // video_analysis even against the suite default.
  await setToolVisionModelRef('prov/mm', await resolveModelRef('prov/mm'));
  const rt = await resolveVisionRuntime({ modelCfg: { ref: 'prov/text-only', multimodal: false } });
  assert.equal(rt.source, 'tools');
  assert.equal(rt.cfg.ref, 'prov/mm');
  assert.ok(rt.perTool.video_analysis);
  assert.equal(rt.perTool.video_analysis.cfg.ref, 'prov/mm2');
  assert.equal(rt.perTool.image_analysis, undefined);

  const tools = await buildVisionTools(rt);
  assert.equal(tools.length, 8);
  const vid = tools.find(t => t.name === 'video_analysis');
  assert.ok(vid.guidelines.join(' ').includes('prov/mm2'), 'video tool description names its own model');
  const img = tools.find(t => t.name === 'image_analysis');
  assert.ok(img.guidelines.join(' ').includes('prov/mm'), 'image tool uses the suite default');
  await clearToolVisionModelRef();
  await clearToolModelRef();
});

test('per-tool: a lone override registers only that tool when no suite default exists', async () => {
  await clearToolVisionModelRef();
  await clearToolModelRef();
  const { resolveModelRef } = await import('../lib/config/home.js');
  await setToolModelRef('ui_diff_check', 'prov/mm2', await resolveModelRef('prov/mm2'));
  const rt = await resolveVisionRuntime({ modelCfg: { ref: 'prov/text-only', multimodal: false } });
  assert.notEqual(rt, null, 'suite registers because one tool is covered');
  assert.equal(rt.cfg, null);
  assert.equal(rt.source, 'none');
  const tools = await buildVisionTools(rt);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ui_diff_check');

  // A tool with NO resolvable tier returns the actionable error.
  const out = await runVisionTool(visionToolByName('image_analysis'), { image_path: 'a.png' }, rt);
  assert.ok(out.error.includes('/tool set-model'));
  await clearToolModelRef();
});

test('per-tool: stale override falls back to the suite default per tool', async () => {
  await clearToolVisionModelRef();
  await clearToolModelRef();
  const { resolveModelRef, withToolSettings } = await import('../lib/config/home.js');
  await setToolVisionModelRef('prov/mm', await resolveModelRef('prov/mm'));
  await withToolSettings((d) => { d.toolModels = { image_analysis: 'prov/gone' }; });
  const rt = await resolveVisionRuntime({ modelCfg: null });
  assert.equal(rt.cfg.ref, 'prov/mm');
  assert.equal(rt.perTool.image_analysis, undefined, 'stale per-tool ref dropped');
  const tools = await buildVisionTools(rt);
  assert.equal(tools.length, 8, 'all tools register via the suite default');
  await clearToolVisionModelRef();
});

// -- 3. argument validation -------------------------------------------------

const RT = { cfg: { ref: 'prov/mm', multimodal: true, style: 'openai' }, source: 'tools' };

test('runVisionTool: missing required argument', async () => {
  const out = await runVisionTool(visionToolByName('image_analysis'), {}, RT);
  assert.ok(out.error.includes('image_path'));
});

test('runVisionTool: non-media extension rejected', async () => {
  const out = await runVisionTool(visionToolByName('image_analysis'), { image_path: 'notes.txt' }, RT);
  assert.ok(out.error.includes('unsupported file type'));
});

test('runVisionTool: wrong media class rejected (image given to video tool)', async () => {
  const out = await runVisionTool(visionToolByName('video_analysis'), { video_path: 'shot.png' }, RT);
  assert.ok(out.error.includes('expected video'));
});

test('runVisionTool: local video over 8 MB rejected before any LLM call', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const big = path.join(dir, 'big.mp4');
  const buf = Buffer.alloc(MAX_VIDEO_TOOL_BYTES + 1024, 1);
  await fs.promises.writeFile(big, buf);
  const out = await runVisionTool(visionToolByName('video_analysis'), { video_path: big }, RT);
  assert.ok(out.error.includes('8 MB'), out.error);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runVisionTool: small local video passes the cap check (fails later at network, not size)', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const small = path.join(dir, 'small.mp4');
  await fs.promises.writeFile(small, Buffer.alloc(2048, 1));
  const out = await runVisionTool(visionToolByName('video_analysis'), { video_path: small }, RT);
  // Size check passed; the stub-free LLM call fails on an unreachable base
  // URL — the error must NOT be the size error.
  assert.ok(!String(out.error || '').includes('8 MB'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runVisionTool: no vision runtime → actionable fix hint', async () => {
  const out = await runVisionTool(visionToolByName('image_analysis'), { image_path: 'a.png' }, null);
  assert.ok(out.error.includes('/tool set-model'));
});

test('runVisionTool: nonexistent local file reported clearly', async () => {
  const out = await runVisionTool(visionToolByName('video_analysis'), { video_path: '/nonexistent/x.mp4' }, RT);
  assert.ok(out.error.includes('file not found') || out.error.includes('not found'), out.error);
});

// -- 4. buildVisionTools / buildTools wiring --------------------------------

test('buildVisionTools: empty without a runtime; full with one', async () => {
  assert.equal((await buildVisionTools(null)).length, 0);
  const tools = await buildVisionTools(RT);
  assert.equal(tools.length, 8);
  for (const t of tools) {
    assert.ok(t.name && t.description && t.parameters && typeof t.execute === 'function');
  }
});

test('buildVisionTools: disabled names excluded', async () => {
  const tools = await buildVisionTools(RT, { disabled: ['video_analysis', 'image_analysis'] });
  const names = tools.map(t => t.name);
  assert.equal(tools.length, 6);
  assert.ok(!names.includes('video_analysis'));
  assert.ok(!names.includes('image_analysis'));
});

test('buildTools: visionTools array appended after built-ins; absent when omitted', async () => {
  const pre = await buildVisionTools(RT);
  const withVision = buildTools({}, { visionTools: pre });
  const names = withVision.map(t => t.name);
  assert.ok(names.includes('read'));
  assert.ok(names.includes('ui_to_artifact'));
  // vision tools come after the built-ins (registry order preserved)
  assert.ok(names.indexOf('ui_to_artifact') > names.indexOf('read'));
  const without = buildTools({}, {});
  assert.equal(without.filter(t => VISION_TOOL_NAMES.includes(t.name)).length, 0);
});

// -- 5. end-to-end with a stubbed LLM client --------------------------------

test('end-to-end: image_analysis call assembles content blocks and returns the text', async (t) => {
  const calls = [];
  const origComplete = LLMClient.prototype.complete;
  t.after(() => { LLMClient.prototype.complete = origComplete; });
  LLMClient.prototype.complete = async function (messages, opts) {
    calls.push({ cfg: this.config, messages, opts });
    return 'ANALYSIS: 图中是一个登录表单';
  };

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const img = path.join(dir, 'ui.png');
  await fs.promises.writeFile(img, Buffer.from('89504e470d0a1a0a', 'hex'));

  const tool = (await buildVisionTools(RT)).find(x => x.name === 'image_analysis');
  const out = await tool.execute({ image_path: img, question: '这个页面是什么' });

  assert.equal(out.error, undefined);
  assert.equal(out.tool, 'image_analysis');
  assert.equal(out.model, 'prov/mm');
  assert.equal(out.result, 'ANALYSIS: 图中是一个登录表单');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cfg.ref, 'prov/mm');
  // The user message carries text + image_url content blocks.
  const user = calls[0].messages.find(m => m.role === 'user');
  assert.ok(Array.isArray(user.content), 'user content is a block array');
  const textBlock = user.content.find(b => b.type === 'text');
  const imgBlock = user.content.find(b => b.type === 'image_url');
  assert.ok(textBlock && textBlock.text.includes('这个页面是什么'));
  assert.ok(imgBlock.image_url.url.startsWith('data:image/png;base64,'));
  // System prompt present.
  assert.ok(calls[0].messages[0].role === 'system');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: per-tool override actually routes to that model', async (t) => {
  const calls = [];
  const origComplete = LLMClient.prototype.complete;
  t.after(() => { LLMClient.prototype.complete = origComplete; });
  LLMClient.prototype.complete = async function (messages) {
    calls.push({ cfg: this.config });
    return 'ok';
  };

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const img = path.join(dir, 'ui.png');
  await fs.promises.writeFile(img, Buffer.from('00', 'hex'));

  const RT2 = {
    cfg: { ref: 'prov/mm', multimodal: true, style: 'openai' },
    source: 'tools',
    perTool: {
      image_analysis: { cfg: { ref: 'prov/mm2', multimodal: true, style: 'openai' } },
    },
  };
  const tool = (await buildVisionTools(RT2)).find(x => x.name === 'image_analysis');
  const out = await tool.execute({ image_path: img, question: 'x' });
  assert.equal(out.model, 'prov/mm2');
  assert.equal(calls[0].cfg.ref, 'prov/mm2');

  // A sibling tool without an override keeps the suite default.
  const sibling = (await buildVisionTools(RT2)).find(x => x.name === 'ui_to_artifact');
  await sibling.execute({ image_path: img });
  assert.equal(calls[1].cfg.ref, 'prov/mm');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: ui_diff_check forwards two images in order', async (t) => {
  const seen = [];
  const origComplete = LLMClient.prototype.complete;
  t.after(() => { LLMClient.prototype.complete = origComplete; });
  LLMClient.prototype.complete = async function (messages) {
    const user = messages.find(m => m.role === 'user');
    seen.push(user.content.filter(b => b.type === 'image_url').map(b => b.image_url.url.slice(0, 30)));
    return '结论: 一致';
  };
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const a = path.join(dir, 'design.png');
  const b = path.join(dir, 'impl.png');
  await fs.promises.writeFile(a, Buffer.from('00', 'hex'));
  await fs.promises.writeFile(b, Buffer.from('01', 'hex'));

  const tool = (await buildVisionTools(RT)).find(x => x.name === 'ui_diff_check');
  const out = await tool.execute({ design_path: a, implementation_path: b });
  assert.equal(out.result, '结论: 一致');
  assert.equal(seen[0].length, 2);
  assert.notEqual(seen[0][0], seen[0][1]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: vision call failure surfaces a model-attributed error', async (t) => {
  const origComplete = LLMClient.prototype.complete;
  t.after(() => { LLMClient.prototype.complete = origComplete; });
  LLMClient.prototype.complete = async () => { throw new Error('connection refused'); };

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hk2-vis-'));
  const img = path.join(dir, 'ui.png');
  await fs.promises.writeFile(img, Buffer.from('00', 'hex'));
  const tool = (await buildVisionTools(RT)).find(x => x.name === 'image_analysis');
  const out = await tool.execute({ image_path: img });
  assert.ok(out.error.includes('prov/mm') && out.error.includes('connection refused'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// -- config layer persistence ----------------------------------------------

test('tool settings: enable/disable/reset persist and filter the suite', async () => {
  await resetToolDisabled();
  const r1 = await setToolEnabled('image_analysis', false, VISION_TOOL_NAMES);
  assert.equal(r1.ok, true);
  let s = await loadToolSettings();
  assert.deepEqual(s.disabled, ['image_analysis']);
  const r2 = await setToolEnabled('image_analysis', true, VISION_TOOL_NAMES);
  assert.equal(r2.ok, true);
  s = await loadToolSettings();
  assert.deepEqual(s.disabled, []);
  const bad = await setToolEnabled('not_a_tool', false, VISION_TOOL_NAMES);
  assert.ok(bad.error);
  await resetToolDisabled();
});
