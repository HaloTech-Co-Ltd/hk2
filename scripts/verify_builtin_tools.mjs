#!/usr/bin/env node
/*
 * verify_builtin_tools.mjs — end-to-end verification of the server-side
 * built-in tool declaration path (modelOptions.tools on an Anthropic-style
 * endpoint).
 *
 * Verifies, against a REAL endpoint (no fetch mocking):
 *   1. resolveModelRef('<ref>') loads the model's stored config — including
 *      modelOptions.tools — from the user's models.json (keys stay in
 *      models.json; this script never embeds credentials).
 *   2. streamAnthropic merges the declared built-ins into body.tools.
 *   3. A 'notice' stream event confirms the declaration BEFORE any HTTP
 *      traffic (positive confirmation; near-miss family names warn).
 *
 * Usage (run OUTSIDE the hk2 sandbox, from the repo root):
 *   node scripts/verify_builtin_tools.mjs bigmodel3/glm-5.3[1m]
 *   node scripts/verify_builtin_tools.mjs bigmodel3/glm-5.3[1m] \
 *     '[{"type":"web_search_20250305"},{"type":"web_fetch_20250910","max_uses":3}]'
 *   (the optional 2nd arg overrides modelOptions.tools for the live test;
 *    near-miss forms like [{"type":"web_search"}] demonstrate the warning)
 *
 * Exit codes: 0 = all checks passed; 1 = assertion/verification failure;
 * 2 = usage error (missing ref).
 */
import { resolveModelRef } from '../lib/config/home.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';

const ref = process.argv[2];
if (!ref) {
  console.error('usage: node scripts/verify_builtin_tools.mjs <provider/model-id> [tools-json]');
  process.exit(2);
}

const cfg = await resolveModelRef(ref);
if (!cfg) {
  console.error(`✗ model ref "${ref}" not found in models.json`);
  process.exit(1);
}
if ((cfg.style || '').toLowerCase() !== 'anthropic') {
  console.error(`✗ model "${ref}" is dialect "${cfg.style}" — server-side built-in tools are Anthropic-dialect only; reconfigure with --api=anthropic`);
  process.exit(1);
}
console.log(`✓ resolved ${ref} → style=${cfg.style} baseUrl=${cfg.baseUrl} model=${cfg.model}`);
console.log(`  modelOptions = ${JSON.stringify(cfg.modelOptions)}`);

let modelOptions = cfg.modelOptions;
if (process.argv[3]) {
  let parsed;
  try { parsed = JSON.parse(process.argv[3]); }
  catch (err) {
    console.error(`✗ tools-json is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  modelOptions = { ...(cfg.modelOptions || {}), tools: parsed };
  console.log(`  OVERRIDE modelOptions.tools = ${JSON.stringify(parsed)}`);
}

let sawNotice = null;
let usage = null;
let textLen = 0;
let replyText = '';
try {
  for await (const evt of streamAnthropic({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    modelType: cfg.modelType,
    modelOptions,
    headers: cfg.headers,
    // A tiny prompt keeps cost negligible; built-ins declared via
    // modelOptions ride on the same request body as any normal call.
    // VERIFY_PROMPT overrides it for a live real-time-fetch probe.
    messages: [{ role: 'user', content: process.env.VERIFY_PROMPT || 'Reply with the single word: ok' }],
    maxChars: 8192,
    enableReasoning: false,
    timeoutMs: 120000,
  })) {
    if (evt.type === 'notice') {
      sawNotice = evt.message;
      console.log(`  [notice] ${evt.message}`);
    } else if (evt.type === 'delta') {
      textLen += evt.text.length;
      replyText += evt.text;
    } else if (evt.type === 'usage') {
      usage = evt;
    }
  }
} catch (err) {
  console.error(`✗ stream failed: ${err.message}`);
  process.exit(1);
}

const declared = Array.isArray(cfg.modelOptions?.tools);
if (declared && !sawNotice) {
  console.error('✗ modelOptions.tools is configured but NO declaration notice appeared — the merge did not reach the wire');
  process.exit(1);
}
if (sawNotice && /not a recognized built-in/.test(sawNotice)) {
  console.error(`✗ near-miss warning: ${sawNotice}`);
  process.exit(1);
}
console.log(`✓ stream completed: ${textLen} chars of text, notice=${sawNotice ? 'yes' : 'none (no modelOptions.tools configured)'}`);
if (usage) console.log(`  usage: in=${usage.input} out=${usage.output}`);
if (process.env.VERIFY_PROMPT) console.log('--- reply text (up to first 600 chars) ---');
if (process.env.VERIFY_PROMPT) console.log(replyText.slice(0, 600));
console.log('ALL CHECKS PASSED');
