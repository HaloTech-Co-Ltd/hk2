/*-------------------------------------------------------------------------
 *
 * Regression tests: Anthropic adapter support for the OFFICIAL Messages API
 * top-level request parameters (checked against
 * https://platform.claude.com/docs/en/api/messages):
 *
 *   stop_sequences, metadata, service_tier, container, inference_geo,
 *   output_config, cache_control, tool_choice, tools, thinking.display
 *
 * These parameters are not dedicated CLI flags; they ride on the model's
 * modelOptions (configured via `/model add|set --model-options=...`), are
 * validated by applyAnthropicPassthrough, and are forwarded verbatim onto
 * the /v1/messages request body. Invalid shapes are dropped (never sent)
 * so a misconfigured model cannot 400 the request.
 *
 * Also covers the usage-side cache_creation OBJECT form
 * ({ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}) that the current
 * official API returns in message_start / message_delta usage snapshots.
 *
 * Run:  node --test test/anthropic_api_params.test.js
 *-----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';

function sseBody() {
  const events = [
    { event: 'message_start', data: { message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: {} },
  ];
  return events
    .map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
}

function makeResp() {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      [Symbol.asyncIterator]: async function* () {
        yield new TextEncoder().encode(sseBody());
      },
      getReader() {
        let pushed = false;
        const buf = new TextEncoder().encode(sseBody());
        return {
          read: async () => {
            if (pushed) return { done: true, value: undefined };
            pushed = true;
            return { done: false, value: buf };
          },
        };
      },
    },
  };
}

function makeRespWithEvents(events) {
  const buf = events
    .map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join('');
  const enc = new TextEncoder().encode(buf);
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      [Symbol.asyncIterator]: async function* () { yield enc; },
      getReader() {
        let pushed = false;
        return {
          read: async () => {
            if (pushed) return { done: true, value: undefined };
            pushed = true;
            return { done: false, value: enc };
          },
        };
      },
    },
  };
}

async function captureBody({ modelOptions, tools, enableReasoning, temperature } = {}) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeResp();
  };
  try {
    for await (const _evt of streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      modelOptions,
      tools,
      enableReasoning,
      temperature,
    })) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

test('baseline: no modelOptions → none of the passthrough keys present, tool_choice defaults absent without tools', async () => {
  const body = await captureBody({ enableReasoning: false });
  for (const k of ['stop_sequences', 'metadata', 'service_tier', 'container',
    'inference_geo', 'output_config', 'cache_control', 'tool_choice', 'top_p', 'top_k']) {
    assert.equal(body[k], undefined, `${k} must be absent`);
  }
});

test('stop_sequences forwards verbatim', async () => {
  const body = await captureBody({ modelOptions: { stop_sequences: ['\n\nHuman:', 'END.'] } });
  assert.deepEqual(body.stop_sequences, ['\n\nHuman:', 'END.']);
});

test('stop_sequences rejects non-array / non-string entries', async () => {
  const body = await captureBody({ modelOptions: { stop_sequences: 'END' } });
  assert.equal(body.stop_sequences, undefined, 'string (non-array) value must be dropped');
  const body2 = await captureBody({ modelOptions: { stop_sequences: ['ok', 42] } });
  assert.equal(body2.stop_sequences, undefined, 'non-string entry must drop the whole param');
});

test('metadata.user_id forwards verbatim', async () => {
  const body = await captureBody({ modelOptions: { metadata: { user_id: 'user_1234' } } });
  assert.deepEqual(body.metadata, { user_id: 'user_1234' });
});

test('metadata rejects non-object and over-long user_id', async () => {
  const body = await captureBody({ modelOptions: { metadata: 'x' } });
  assert.equal(body.metadata, undefined);
  const body2 = await captureBody({ modelOptions: { metadata: { user_id: 'x'.repeat(513) } } });
  assert.equal(body2.metadata, undefined);
});

test('service_tier forwards both enum values; rejects others', async () => {
  for (const v of ['auto', 'standard_only']) {
    const body = await captureBody({ modelOptions: { service_tier: v } });
    assert.equal(body.service_tier, v);
  }
  const bad = await captureBody({ modelOptions: { service_tier: 'priority' } });
  assert.equal(bad.service_tier, undefined, 'invalid enum must be dropped');
});

test('container forwards id string and {id, skills} object', async () => {
  const b1 = await captureBody({ modelOptions: { container: 'container_abc' } });
  assert.equal(b1.container, 'container_abc');
  const skills = [{ type: 'anthropic', skill_id: 'skill_x', version: 'latest' }];
  const b2 = await captureBody({ modelOptions: { container: { id: 'c1', skills } } });
  assert.deepEqual(b2.container, { id: 'c1', skills });
});

test('container rejects bogus shapes', async () => {
  assert.equal((await captureBody({ modelOptions: { container: '' } })).container, undefined);
  assert.equal((await captureBody({ modelOptions: { container: 42 } })).container, undefined);
  assert.equal(
    (await captureBody({ modelOptions: { container: { skills: 'nope' } } })).container,
    undefined,
    'skills must be an array'
  );
});

test('inference_geo forwards; rejects empty / non-string', async () => {
  const body = await captureBody({ modelOptions: { inference_geo: 'eu' } });
  assert.equal(body.inference_geo, 'eu');
  assert.equal((await captureBody({ modelOptions: { inference_geo: '' } })).inference_geo, undefined);
  assert.equal((await captureBody({ modelOptions: { inference_geo: 7 } })).inference_geo, undefined);
});

test('output_config forwards effort and json_schema format', async () => {
  const format = { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } };
  const body = await captureBody({ modelOptions: { output_config: { effort: 'high', format } } });
  assert.deepEqual(body.output_config, { effort: 'high', format });
});

test('output_config rejects bad effort and bad format', async () => {
  assert.equal((await captureBody({ modelOptions: { output_config: { effort: 'ultra' } } })).output_config, undefined);
  assert.equal(
    (await captureBody({ modelOptions: { output_config: { format: { type: 'text' } } } })).output_config,
    undefined,
    'format.type must be json_schema'
  );
  assert.equal(
    (await captureBody({ modelOptions: { output_config: { format: { type: 'json_schema' } } } })).output_config,
    undefined,
    'format.schema is required'
  );
});

test('cache_control forwards {type:ephemeral, ttl}', async () => {
  const body = await captureBody({ modelOptions: { cache_control: { type: 'ephemeral', ttl: '1h' } } });
  assert.deepEqual(body.cache_control, { type: 'ephemeral', ttl: '1h' });
  const body2 = await captureBody({ modelOptions: { cache_control: { type: 'ephemeral' } } });
  assert.deepEqual(body2.cache_control, { type: 'ephemeral' }, 'ttl optional (defaults 5m)');
});

test('cache_control rejects wrong type / ttl', async () => {
  assert.equal((await captureBody({ modelOptions: { cache_control: { type: 'persistent' } } })).cache_control, undefined);
  assert.equal((await captureBody({ modelOptions: { cache_control: { type: 'ephemeral', ttl: '2h' } } })).cache_control, undefined);
});

test('tool_choice forwards all four types + disable_parallel_tool_use; bare "auto" normalized to object form', async () => {
  const cases = [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'auto' }, { type: 'auto' }],
    [{ type: 'any', disable_parallel_tool_use: true }, { type: 'any', disable_parallel_tool_use: true }],
    [{ type: 'tool', name: 'read' }, { type: 'tool', name: 'read' }],
    [{ type: 'none' }, { type: 'none' }],
  ];
  for (const [expected, tc] of cases) {
    const body = await captureBody({ modelOptions: { tool_choice: tc } });
    assert.deepEqual(body.tool_choice, expected, JSON.stringify(tc));
  }
});

test('tool_choice validation: bare non-auto string, missing name, bad disable_parallel', async () => {
  assert.equal((await captureBody({ modelOptions: { tool_choice: 'any' } })).tool_choice, undefined);
  assert.equal((await captureBody({ modelOptions: { tool_choice: { type: 'tool' } } })).tool_choice, undefined);
  assert.equal(
    (await captureBody({ modelOptions: { tool_choice: { type: 'auto', disable_parallel_tool_use: 'yes' } } })).tool_choice,
    undefined
  );
});

test('tools present without explicit tool_choice → defaults to {type:"auto"}', async () => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } } }];
  const body = await captureBody({ tools });
  assert.ok(Array.isArray(body.tools));
  assert.equal(body.tools[0].name, 'read');
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: {} });
  assert.deepEqual(body.tool_choice, { type: 'auto' }, 'Anthropic tool_choice must be an OBJECT, not the OpenAI string');
});

test('explicit tool_choice overrides the auto default when tools are present', async () => {
  const tools = [{ type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } } }];
  const body = await captureBody({ tools, modelOptions: { tool_choice: { type: 'any' } } });
  assert.deepEqual(body.tool_choice, { type: 'any' });
});

test('thinking.display override honored only when reasoning is on', async () => {
  const on = await captureBody({ enableReasoning: true, modelOptions: { thinking: { display: 'omitted' } } });
  assert.equal(on.thinking.display, 'omitted');
  assert.equal(typeof on.thinking.budget_tokens, 'number');
  const off = await captureBody({ enableReasoning: false, modelOptions: { thinking: { display: 'omitted' } } });
  assert.equal(off.thinking, undefined);
});

test('top_p / top_k forward as numbers when thinking is OFF; dropped when ON (official mutual exclusion)', async () => {
  const off = await captureBody({ enableReasoning: false, modelOptions: { top_p: 0.9, top_k: 40 } });
  assert.equal(off.top_p, 0.9);
  assert.equal(off.top_k, 40);
  // Extended thinking cannot be combined with top_p/top_k (API 400s);
  // the adapter drops them so a stored value can't break every request.
  const on = await captureBody({ enableReasoning: true, modelOptions: { top_p: 0.9, top_k: 40 } });
  assert.equal(on.top_p, undefined, 'top_p dropped when thinking is enabled');
  assert.equal(on.top_k, undefined, 'top_k dropped when thinking is enabled');
});

test('temperature: omitted when unset (deprecated param, new models reject non-1.0), explicit value forwarded when thinking is off', async () => {
  // No explicit temperature anywhere → the field must be OMITTED entirely:
  // the official API default is 1.0 and post-Opus-4.6 models 400 on anything
  // else, so a baked-in CLI 0.2 default would break every request.
  const unsetOff = await captureBody({ enableReasoning: false });
  assert.equal(unsetOff.temperature, undefined, 'unset temperature must not be sent');
  const unsetOn = await captureBody({ enableReasoning: true });
  assert.equal(unsetOn.temperature, 1, 'thinking still pins temperature=1');
  // An explicit temperature travels only when thinking is OFF.
  const explicitOff = await captureBody({ enableReasoning: false, temperature: 0.7 });
  assert.equal(explicitOff.temperature, 0.7);
  // Thinking ON pins 1 regardless of an explicit value (official constraint).
  const explicitOn = await captureBody({ enableReasoning: true, temperature: 0.7 });
  assert.equal(explicitOn.temperature, 1);
});

test('built-in server tools (ToolUnion dated variants) pass through with type + config intact', async () => {
  const builtin = {
    type: 'function',
    function: { name: 'web_search_20250305', description: 'ignored for built-ins', parameters: { type: 'object' } },
  };
  const body = await captureBody({ tools: [builtin] });
  assert.equal(body.tools[0].type, 'web_search_20250305', 'type must survive');
  assert.equal(body.tools[0].input_schema, undefined, 'built-ins carry no input_schema');
  assert.equal(body.tools[0].description, undefined, 'OpenAI envelope fields not forwarded');
});

test('built-in tool with native shape (type at top level) forwards config fields', async () => {
  const native = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
    allowed_domains: ['example.com'],
    user_location: { type: 'approximate', country: 'US' },
  };
  const body = await captureBody({ tools: [native] });
  assert.deepEqual(body.tools[0], native, 'verbatim forward');
});

test('bash_20250124 / web_fetch_20250910 / web_fetch_20260309 recognized via function.name', async () => {
  for (const t of ['bash_20250124', 'web_fetch_20250910', 'web_fetch_20260309', 'code_execution_20250825', 'text_editor_20250728', 'memory_20250818']) {
    const body = await captureBody({ tools: [{ type: 'function', function: { name: t, parameters: { type: 'object' } } }] });
    assert.equal(body.tools[0].type, t, `${t} recognized`);
    assert.equal(body.tools.length, 1);
  }
});

test('envelope-recognized built-ins carry their CANONICAL required name (official ToolUnion literals)', async () => {
  // Every built-in except the toolsets REQUIRES `name` as a fixed literal;
  // the OpenAI envelope (function.name === type string) carries no top-level
  // name, so the adapter must fill the canonical one — sending `type` without
  // `name` (or with the type string AS the name) 400s on the official API.
  const cases = [
    ['bash_20250124', 'bash'],
    ['code_execution_20250522', 'code_execution'],
    ['code_execution_20260120', 'code_execution'],
    ['text_editor_20250124', 'str_replace_editor'],
    ['text_editor_20250429', 'str_replace_based_edit_tool'],
    ['text_editor_20250728', 'str_replace_based_edit_tool'],
    ['web_search_20250305', 'web_search'],
    ['web_search_20260318', 'web_search'],
    ['web_fetch_20250910', 'web_fetch'],
    ['web_fetch_20260318', 'web_fetch'],
    ['memory_20250818', 'memory'],
    ['tool_search_tool_regex_20251119', 'tool_search_tool_regex'],
    ['tool_search_tool_bm25_20251119', 'tool_search_tool_bm25'],
  ];
  for (const [typeStr, canonicalName] of cases) {
    const body = await captureBody({ tools: [{ type: 'function', function: { name: typeStr, parameters: { type: 'object' } } }] });
    assert.equal(body.tools[0].type, typeStr);
    assert.equal(body.tools[0].name, canonicalName, `${typeStr} must map to canonical name ${canonicalName}`);
  }
});

test('tool_search_tool_bm25_20251119 and undated aliases recognized (top-level type and function.name)', async () => {
  for (const t of ['tool_search_tool_bm25_20251119', 'tool_search_tool_bm25', 'tool_search_tool_regex']) {
    const viaType = await captureBody({ tools: [{ type: t }] });
    assert.equal(viaType.tools[0].type, t, `${t} recognized via top-level type`);
    assert.ok(viaType.tools[0].name, `${t} gets a canonical name`);
    const viaEnvelope = await captureBody({ tools: [{ type: 'function', function: { name: t } }] });
    assert.equal(viaEnvelope.tools[0].type, t, `${t} recognized via function.name`);
    assert.ok(viaEnvelope.tools[0].name, `${t} (envelope) gets a canonical name`);
  }
});

test('toolsets (computer/browser) carry NO name — forwarding one would 400', async () => {
  for (const t of ['computer_toolset_20260801', 'browser_toolset_20260801']) {
    const body = await captureBody({ tools: [{ type: t }] });
    assert.equal(body.tools[0].type, t);
    assert.equal(body.tools[0].name, undefined, `${t} must NOT carry a name`);
  }
});

test('custom tools keep the {name, description, input_schema} mapping and omit empty description', async () => {
  const body = await captureBody({
    tools: [
      { type: 'function', function: { name: 'read', description: 'd', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'bare', parameters: { type: 'object' } } },
    ],
  });
  assert.equal(body.tools[0].name, 'read');
  assert.equal(body.tools[0].description, 'd');
  assert.deepEqual(body.tools[0].input_schema, { type: 'object', properties: {} });
  assert.equal(body.tools[1].description, undefined, 'no empty description key');
});

test('malformed tool entries are dropped instead of sending garbage', async () => {
  const body = await captureBody({ tools: [null, { type: 'function' }, { type: 'function', function: {} }] });
  assert.deepEqual(body.tools, []);
});

test('unknown modelOptions keys are never forwarded', async () => {
  const body = await captureBody({ modelOptions: { enable_thinking: true, reasoning_effort: 'max', custom_thing: { a: 1 } } });
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.custom_thing, undefined);
});

test('usage: message_start reports cache_creation OBJECT form as a scalar total', async () => {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeRespWithEvents([
      {
        event: 'message_start',
        data: {
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 50,
              cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 12 },
            },
          },
        },
      },
      { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: {} },
    ]);
  };
  const events = [];
  try {
    for await (const evt of streamAnthropic({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], maxChars: 8192,
    })) events.push(evt);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured);
  const u = events.find(e => e.type === 'usage' && e.input === 100);
  assert.ok(u, 'usage event with input=100 exists');
  assert.equal(u.cache_read, 50);
  assert.equal(u.cache_creation, 42, 'object form summed to a scalar (30+12)');
});

test('usage: legacy scalar cache_creation_input_tokens still accepted', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeRespWithEvents([
    {
      event: 'message_start',
      data: {
        message: {
          usage: {
            input_tokens: 10, output_tokens: 0,
            cache_creation_input_tokens: 7,
          },
        },
      },
    },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: {} },
  ]);
  const events = [];
  try {
    for await (const evt of streamAnthropic({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], maxChars: 8192,
    })) events.push(evt);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const u = events.find(e => e.type === 'usage' && e.input === 10);
  assert.equal(u.cache_creation, 7);
});

test('finish event carries stop_sequence when the model hit a configured stop sequence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeRespWithEvents([
    { event: 'message_start', data: { message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'stop_sequence', stop_sequence: 'END.' }, usage: { output_tokens: 1 } } },
    { event: 'message_stop', data: {} },
  ]);
  const events = [];
  try {
    for await (const evt of streamAnthropic({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], maxChars: 8192,
    })) events.push(evt);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const finish = events.filter(e => e.type === 'finish').at(-1);
  assert.equal(finish.reason, 'stop_sequence');
  assert.equal(finish.stop_sequence, 'END.');
});

test('mid-stream event:error is thrown (retryable upstream), never silently truncated', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => makeRespWithEvents([
    { event: 'message_start', data: { message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'text_delta', text: 'part' } } },
    { event: 'error', data: { type: 'overloaded_error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]);
  let threw = null;
  try {
    for await (const _evt of streamAnthropic({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], maxChars: 8192,
    })) { /* drain */ }
  } catch (err) {
    threw = err;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(threw, 'error event must throw');
  assert.match(threw.message, /overloaded/i);
  assert.match(threw.message, /stream error/);
});
