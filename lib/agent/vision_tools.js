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
 * Multimodal vision tool suite.
 *
 * Eight specialized tools (ui_to_artifact, extract_text_from_screenshot,
 * diagnose_error_screenshot, understand_technical_diagram,
 * analyze_data_visualization, ui_diff_check, image_analysis,
 * video_analysis) that give ANY session model multimodal capabilities:
 * each tool internally forwards the media to a DEDICATED multimodal model
 * (configured via `/tool set-model <ref>`, stored in ~/.hk2/tools.json) and
 * returns that model's textual analysis as the tool result. The session
 * model itself never needs to accept image/video input — it just calls the
 * tool like any other.
 *
 * Resolution order for the vision model (resolveVisionRuntime), PER TOOL:
 *   1. tools.json `toolModels[<tool>]` — a per-tool override, validated at
 *      every read to still resolve multimodal:true (stale refs fall through,
 *      never throw);
 *   2. tools.json `visionModelRef` — the suite-wide default, same per-read
 *      validation;
 *   3. the session's active model, when it has --multimodal=on;
 *   4. null — that tool is then not registered at all.
 *
 * Execution (runVisionTool): validate inputs against the tool's declared
 * media classes, build OpenAI-style content blocks via
 * lib/agent/attachments.js (local files → Base64 data URLs, remote
 * http(s) URLs pass through), and make ONE complete() call on an LLMClient
 * constructed from the resolved vision config. Video tools enforce a
 * stricter local-file cap (8 MB) than the generic 20 MB attachment cap.
 */
import { stat } from 'node:fs/promises';
import {
  mediaClassOf,
  isRemoteUrl,
  buildAttachmentBlocks,
  buildMultimodalContent,
} from './attachments.js';
import LLMClient from '../llm/client.js';

/** Stricter local-file cap for the video_analysis tool (per its contract). */
export const MAX_VIDEO_TOOL_BYTES = 8 * 1024 * 1024;

/** Shared system prompt for every vision call (English only). */
const SHARED_SYSTEM_PROMPT = [
  'You are a meticulous multimodal analysis engine embedded in a coding agent.',
  'You receive one or more media attachments (images or video) plus a task.',
  'Ground every statement in what is actually visible; never invent details.',
  'Preserve exact text, numbers, identifiers and code when quoting them.',
  'Structure long answers with headings or bullet lists.',
  'Reply in the same language as the task instruction (default: Simplified Chinese).',
].join(' ');

  /**
 * The vision tool registry. Each entry:
 *   name        tool name (also the agent-facing tool id)
 *   snippet     one-line English summary — used in the agent-facing tool
 *               definition AND the /tool list UI copy (English-only policy)
 *   media       media class every input must be ('image' | 'video')
 *   inputs      ordered [{arg, label}] — each arg is a path/URL string
 *   instruction per-tool task instruction sent as the user text (English)
 *   extraParams additional string arguments appended to the user text
 *   parameters  JSON-schema for the tool registration
 */
export const VISION_TOOLS = [
  {
    name: 'ui_to_artifact',
    snippet: 'Convert a UI screenshot into front-end code, a generative-design prompt, a design spec, or a natural-language description',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'UI screenshot' }],
    instruction: [
      'Convert this UI screenshot into a reusable artifact.',
      'The `target` argument selects the output form:',
      '- code: production-ready front-end code (framework from `framework`, default responsive HTML+TailwindCSS) reproducing layout, spacing, colors, typography, states and content; note any detail you had to approximate.',
      '- prompt: a generative-design prompt that recreates this design (style tokens, layout structure, component inventory, palette with hex values, typography, mood).',
      '- design_spec: a structured design specification (layout grid, components with props/states, color tokens, type scale, spacing scale, iconography, interaction notes).',
      '- description: a precise natural-language description of the screen.',
    ].join('\n'),
    extraParams: [
      { arg: 'target', values: ['code', 'prompt', 'design_spec', 'description'], default: 'code' },
      { arg: 'framework', values: null, default: null },
    ],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the UI screenshot (png/jpg/jpeg/gif/webp/bmp)' },
        target: { type: 'string', enum: ['code', 'prompt', 'design_spec', 'description'], description: "Output artifact form (default 'code')" },
        framework: { type: 'string', description: "Target framework for target=code, e.g. 'react', 'vue', 'html-tailwind' (optional)" },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'extract_text_from_screenshot',
    snippet: 'Extract and recognize text from screenshots with OCR-grade fidelity (code, terminal output, documents, general text)',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'screenshot to OCR' }],
    instruction: [
      'Extract ALL text from this screenshot with OCR-grade fidelity.',
      '`content_type` hints the content:',
      '- code: reproduce it as a fenced code block with the detected language, preserving indentation and line breaks exactly.',
      '- terminal: reproduce the full terminal output verbatim including prompts, flags and paths.',
      '- document: reproduce paragraphs and headings, keeping reading order.',
      '- general: plain transcription, preserving line structure.',
      'Transcribe ONLY what is visible; mark illegible fragments as [illegible].',
      'When `preserve_layout` is true, use spacing/alignment to mirror the visual layout.',
    ].join('\n'),
    extraParams: [
      { arg: 'content_type', values: ['general', 'code', 'terminal', 'document'], default: 'general' },
      { arg: 'preserve_layout', values: ['true', 'false'], default: 'false' },
    ],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the screenshot (png/jpg/jpeg/gif/webp/bmp)' },
        content_type: { type: 'string', enum: ['general', 'code', 'terminal', 'document'], description: "Content hint (default 'general')" },
        preserve_layout: { type: 'boolean', description: 'Mirror the visual layout with spacing (default false)' },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'diagnose_error_screenshot',
    snippet: 'Parse error dialogs, stack traces and log screenshots; give locating hints and fix suggestions',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'error screenshot' }],
    instruction: [
      'Diagnose the error shown in this screenshot (dialog, stack trace, log output, failed test, panic, etc.).',
      'Produce:',
      '1. Summary — what failed, in one or two sentences.',
      '2. Key facts — exact error message(s), error codes, file paths, line numbers, symbol names (verbatim).',
      '3. Likely causes — ranked hypotheses grounded in the visible evidence.',
      '4. Locating advice — where to look in the code / which component likely owns the failure.',
      '5. Fix suggestions — concrete next steps or fixes.',
      'Use the optional `context` argument (project/setup background) as an aid, but trust the screenshot first.',
    ].join('\n'),
    extraParams: [{ arg: 'context', values: null, default: null }],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the error screenshot (png/jpg/jpeg/gif/webp/bmp)' },
        context: { type: 'string', description: 'Optional background: project, framework, what the user was doing' },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'understand_technical_diagram',
    snippet: 'Produce a structured interpretation of technical diagrams (architecture, flowchart, UML, ER)',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'technical diagram' }],
    instruction: [
      'Produce a structured interpretation of this technical diagram.',
      'Detect the kind first (architecture / flowchart / sequence / class UML / ER / state / network / other).',
      'Then output:',
      '1. Diagram type and overall purpose.',
      '2. Nodes / entities — every box, actor, table, component with its label (verbatim) and role.',
      '3. Relations and connections — every edge: from → to, label/condition, cardinality where visible.',
      '4. Key flows / paths — the main flows or groupings an engineer must understand.',
      '5. Potential issues — ambiguities, missing labels, or design smells, if any.',
      'When `diagram_type` is given, treat it as the authoritative kind.',
    ].join('\n'),
    extraParams: [{ arg: 'diagram_type', values: ['auto', 'architecture', 'flowchart', 'uml', 'er'], default: 'auto' }],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the diagram (png/jpg/jpeg/gif/webp/bmp)' },
        diagram_type: { type: 'string', enum: ['auto', 'architecture', 'flowchart', 'uml', 'er'], description: "Diagram kind hint (default 'auto' = detect)" },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'analyze_data_visualization',
    snippet: 'Read dashboards and statistical charts; surface trends, anomalies and business takeaways',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'chart / dashboard' }],
    instruction: [
      'Analyze this data visualization (chart, dashboard, report).',
      'Produce:',
      '1. Overview — chart types, dimensions, time range, and what each panel shows.',
      '2. Readings — key values with units, read as precisely as the rendering allows.',
      '3. Trends and patterns — direction, correlation, seasonality, ranking shifts.',
      '4. Anomalies and points of interest — outliers, spikes, dips, missing data, broken axes.',
      '5. Business takeaways — what a decision maker should act on.',
      'Distinguish clearly between read values (visible) and estimates (inferred).',
    ].join('\n'),
    extraParams: [{ arg: 'focus', values: null, default: null }],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the chart/dashboard screenshot (png/jpg/jpeg/gif/webp/bmp)' },
        focus: { type: 'string', description: 'Optional aspect to focus on (e.g. "conversion-rate trend", "any anomaly")' },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'ui_diff_check',
    snippet: 'Compare two UI screenshots and identify visual differences and implementation deviations (design vs implementation)',
    media: 'image',
    inputs: [
      { arg: 'design_path', label: 'design (reference)' },
      { arg: 'implementation_path', label: 'implementation (actual)' },
    ],
    instruction: [
      'Compare the two UI screenshots: the FIRST is the design reference, the SECOND is the implementation to verify.',
      'Produce:',
      '1. Verdict — pass / minor deviations / significant deviations.',
      '2. Difference list — every visual difference grouped by area (layout, spacing, typography, color, icons/imagery, content, states), each with severity (high/medium/low) and where it is on the screen.',
      '3. Likely causes — probable implementation causes (missing style, wrong token, responsive breakpoint, etc.).',
      '4. Fix suggestions — concrete fixes.',
      'Only report differences you can actually see; do not invent styling intents.',
    ].join('\n'),
    extraParams: [],
    parameters: {
      type: 'object',
      properties: {
        design_path: { type: 'string', description: 'Path or http(s) URL of the design/reference screenshot' },
        implementation_path: { type: 'string', description: 'Path or http(s) URL of the implementation/actual screenshot' },
      },
      required: ['design_path', 'implementation_path'],
    },
  },
  {
    name: 'image_analysis',
    snippet: 'General image understanding for visual content not covered by the specialized tools',
    media: 'image',
    inputs: [{ arg: 'image_path', label: 'image' }],
    instruction: [
      'Analyze this image and answer the question.',
      'Describe what is relevant to the question precisely; include notable text, objects, layout and quality issues when they matter.',
      'The `question` argument drives the focus — answer exactly what it asks.',
    ].join('\n'),
    extraParams: [{ arg: 'question', values: null, default: null }],
    parameters: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: 'Path or http(s) URL of the image (png/jpg/jpeg/gif/webp/bmp)' },
        question: { type: 'string', description: 'What to analyze / answer about the image' },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'video_analysis',
    snippet: 'Parse video scenes (MP4/MOV/M4V etc., local files limited to 8 MB): extract key frames, events and takeaways',
    media: 'video',
    inputs: [{ arg: 'video_path', label: 'video' }],
    instruction: [
      'Analyze this video: identify key frames, events and takeaways.',
      'Produce:',
      '1. Overview — content, setting, approximate duration/structure.',
      '2. Key frames / moments — the moments that matter, each with what happens (use timestamps when visible).',
      '3. Event sequence — what happens, in order.',
      '4. Summary — the takeaways.',
      'The optional `focus` argument narrows the analysis.',
    ].join('\n'),
    extraParams: [{ arg: 'focus', values: null, default: null }],
    parameters: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: 'Path or http(s) URL of the video (mp4/mov/mkv/avi/webm/flv/m4v; local files limited to 8 MB)' },
        focus: { type: 'string', description: 'Optional aspect to focus on (e.g. "when the error appears", "the user operation flow")' },
      },
      required: ['video_path'],
    },
  },
];

export const VISION_TOOL_NAMES = VISION_TOOLS.map(t => t.name);

/** Registry lookup by name. */
export function visionToolByName(name) {
  return VISION_TOOLS.find(t => t.name === name) || null;
}

/**
 * Resolve the vision runtime for a turn.
 *
 * @param {{modelCfg?: object}|null} session session context (modelCfg is the
 *        resolved ACTIVE model config)
 * @returns {Promise<{cfg: object, source: 'tools'|'session', perTool: Record<string, {cfg: object, source: 'tools'}>}|null>}
 *          null when NO tier resolves (suite not registered). `cfg`/`source`
 *          describe the SUITE DEFAULT (tier 2/3); `perTool` carries the
 *          resolved per-tool overrides (tier 1) that win over the default.
 */
export async function resolveVisionRuntime(session) {
  const home = await import('../config/home.js');
  let perTool = {};
  try {
    perTool = await home.resolveToolModels();
  } catch { perTool = {}; }
  let suite = null;
  try {
    const cfg = await home.resolveVisionModel();
    if (cfg && cfg.multimodal === true) suite = { cfg, source: 'tools' };
  } catch { /* fall through to the session model */ }
  if (!suite) {
    const sessCfg = session?.modelCfg;
    if (sessCfg && sessCfg.multimodal === true) suite = { cfg: sessCfg, source: 'session' };
  }
  // A per-tool override alone is enough to register the suite — the tools it
  // covers run on their own model even with no suite default at all.
  if (!suite && Object.keys(perTool).length === 0) return null;
  return {
    cfg: suite ? suite.cfg : null,
    source: suite ? suite.source : 'none',
    perTool,
  };
}

/** The effective vision runtime for ONE tool (per-tool override first). */
function effectiveVisionFor(vision, toolName) {
  const per = vision?.perTool?.[toolName];
  if (per?.cfg?.multimodal === true) return { cfg: per.cfg, source: 'tools' };
  if (vision?.cfg?.multimodal === true) return { cfg: vision.cfg, source: vision.source || 'tools' };
  return null;
}

/** Human summary of a media class for error messages. */
function mediaFormats(cls) {
  if (cls === 'video') return 'video (mp4 mov mkv avi webm flv m4v)';
  return 'image (png jpg jpeg gif webp bmp)';
}

/**
 * Collect + validate the media inputs of a tool call.
 *
 * @returns {{ok:true, refs:string[], labels:string[]} | {ok:false, error:string}}
 */
async function collectInputs(tool, args) {
  const refs = [];
  const labels = [];
  for (const input of tool.inputs) {
    const ref = args[input.arg];
    if (!ref || typeof ref !== 'string' || !ref.trim()) {
      return { ok: false, error: `missing required argument: ${input.arg}` };
    }
    const cls = mediaClassOf(ref);
    if (!cls) {
      return { ok: false, error: `${ref}: unsupported file type — expected ${mediaFormats(tool.media)} (classify by extension)` };
    }
    if (cls !== tool.media) {
      return { ok: false, error: `${ref}: expected ${mediaFormats(tool.media)}, got ${cls}` };
    }
    // Stricter local-file cap for video (8 MB per the tool contract).
    if (tool.media === 'video' && !isRemoteUrl(ref)) {
      try {
        const st = await stat(ref);
        if (st.isFile() && st.size > MAX_VIDEO_TOOL_BYTES) {
          return { ok: false, error: `${ref}: video too large (${(st.size / 1048576).toFixed(1)} MB > 8 MB limit for local video_analysis input)` };
        }
      } catch (err) {
        return { ok: false, error: `${ref}: ${err.code === 'ENOENT' ? 'file not found' : (err.message || 'unreadable')}` };
      }
    }
    refs.push(ref);
    labels.push(input.label);
  }
  return { ok: true, refs, labels };
}

/** Render the extra string params into the user prompt. */
function renderExtras(tool, args) {
  const lines = [];
  for (const p of tool.extraParams || []) {
    const v = args[p.arg];
    if (v === undefined || v === null || v === '') continue;
    if (p.values && !p.values.includes(String(v))) {
      // Unknown enum values are surfaced by the caller (schema-conformant
      // models do not send them); here we still forward them verbatim —
      // the vision model can cope with a free-form hint.
    }
    if (p.arg === 'preserve_layout') {
      lines.push(`preserve_layout=${v === true || v === 'true' ? 'true' : 'false'}`);
    } else {
      lines.push(`${p.arg}=${String(v)}`);
    }
  }
  return lines;
}

/**
 * Run one vision tool call.
 *
 * @param {object} tool registry entry
 * @param {object} args tool arguments (paths/URLs + extras)
 * @param {{cfg: object, source: string}} vision resolved vision runtime
 * @returns {Promise<{tool:string, model:string, media:string[], result:string}|{error:string}>}
 */
export async function runVisionTool(tool, args, vision) {
  const eff = effectiveVisionFor(vision, tool.name);
  if (!eff?.cfg) {
    return { error: 'no multimodal model available for this vision tool — configure one with /tool set-model <provider>/<model-id> (multimodal-capable, e.g. glm-5.3-flash with --multimodal=on), or per tool with /tool set-model <tool> <provider>/<model-id>' };
  }
  const collected = await collectInputs(tool, args || {});
  if (!collected.ok) return { error: collected.error };
  const { refs, labels } = collected;

  const out = await buildAttachmentBlocks(refs, {
    maxSizeBytes: tool.media === 'video' ? MAX_VIDEO_TOOL_BYTES : undefined,
  });
  if (!out.ok) return { error: out.errors.join('; ') };

  const prompt = [tool.instruction];
  for (let i = 0; i < labels.length; i++) {
    prompt.push(`Attachment ${i + 1} (${labels[i]}): ${refs[i]}`);
  }
  const extras = renderExtras(tool, args || {});
  if (extras.length > 0) prompt.push(`Arguments:\n${extras.join('\n')}`);

  const messages = [
    { role: 'system', content: SHARED_SYSTEM_PROMPT },
    { role: 'user', content: buildMultimodalContent(prompt.join('\n\n'), out.blocks) },
  ];

  const llm = new LLMClient(eff.cfg);
  try {
    const text = await llm.complete(messages, {
      temperature: 0.2,
      // No fixed timeout: analysis of dense media can legitimately take a
      // long time; cfg.timeout (env-tunable) remains the ceiling.
    });
    return {
      tool: tool.name,
      model: eff.cfg.ref,
      media: refs,
      result: typeof text === 'string' ? text : String(text),
    };
  } catch (err) {
    return { error: `vision model call failed (${eff.cfg.ref}): ${err.message}` };
  }
}

/**
 * Build hk2-shaped tool objects for every ENABLED vision tool that resolves
 * an effective model.
 *
 * @param {{cfg: object, source: string, perTool?: object}|null} vision resolved
 *        runtime; null or a runtime where NO tool resolves yields []
 * @param {{disabled?: string[]}} [opts] disabled tool names (from tools.json)
 * @returns {Promise<object[]>}
 */
export async function buildVisionTools(vision, opts = {}) {
  const disabled = new Set(Array.isArray(opts.disabled) ? opts.disabled : []);
  const tools = [];
  for (const t of VISION_TOOLS) {
    if (disabled.has(t.name)) continue;
    // A tool registers only when SOME tier resolves for it: its own per-tool
    // override, the suite default, or a multimodal session model.
    const eff = effectiveVisionFor(vision, t.name);
    if (!eff) continue;
    const extras = (t.extraParams || [])
      .filter(p => p.arg)
      .map(p => `\`${p.arg}\``)
      .join(', ');
    tools.push({
      name: t.name,
      snippet: t.snippet,
      guidelines: [
        `This tool forwards the media to a dedicated multimodal model (${eff.cfg.ref}) and returns its textual analysis — the session model itself never needs multimodal input.`,
        t.media === 'video'
          ? 'Local video files are limited to 8 MB; remote http(s) video URLs have no local size check.'
          : 'Accepts a local path or an http(s) URL.',
      ],
      description: `${t.snippet}. Forwards the given ${t.media} to a dedicated multimodal model (configured via /tool set-model, falling back to the session model when it is multimodal) and returns its analysis as text${extras ? `; extra arguments: ${extras}` : ''}. The session model does NOT need multimodal input to use this tool.`,
      parameters: t.parameters,
      execute: async (args) => runVisionTool(t, args, vision),
    });
  }
  return tools;
}
