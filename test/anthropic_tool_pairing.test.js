/*-------------------------------------------------------------------------
 *
 * Regression tests for the Anthropic adapter's tool_use / tool_result
 * sanitization pass (lib/llm/anthropic_adapter.js).
 *
 * Anthropic strictly requires every assistant `tool_use` block to be
 * immediately followed by a user `tool_result` with a matching id. The
 * conversation history can be corrupted upstream (context compaction strips
 * `tool` messages but keeps the assistant `tool_calls`; an interrupted turn
 * leaves a trailing assistant `tool_use` with no result), which then 400s on
 * the next call. The adapter repairs both directions so a broken history never
 * reaches the API.
 *
 * These tests stub global `fetch`, capture the request body, and assert the
 * sanitized `messages` array has no orphaned tool_use / tool_result and starts
 * with a user turn.
 *
 * Run:  node --test test/anthropic_tool_pairing.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';

// Minimal valid Anthropic SSE response: message_start -> message_delta(stop)
// -> message_stop. Enough for the adapter to drain the stream and finish.
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
        const buf = sseBody();
        // Yield in one chunk; consumeStreamAsync buffers by line.
        yield new TextEncoder().encode(buf);
      },
      getReader() {
        // Fallback reader interface in case the SSE consumer uses getReader.
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

// Build a Response whose SSE body is a caller-supplied list of {event,data}
// objects. Used by the streaming-event tests (tool_call flush, usage).
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
        return { read: async () => { if (pushed) return { done: true, value: undefined }; pushed = true; return { done: false, value: enc }; } };
      },
    },
  };
}

async function captureRequestBody(messages) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return makeResp();
  };
  try {
    // Drain the generator so the request is actually issued.
    for await (const _evt of streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages,
      maxChars: 8192,
      enableReasoning: false,
      timeoutMs: 1000,
    })) {
      /* discard events */
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  return captured;
}

// Collect every tool_use id and every tool_result id from the final body, and
// verify the Anthropic invariants.
function assertPairing(body) {
  const useIds = new Set();
  const resultIds = new Set();
  for (const m of body.messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_use' && b.id) useIds.add(b.id);
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b?.type === 'tool_result' && b.tool_use_id) resultIds.add(b.tool_use_id);
    }
  }
  // Every tool_use must have a matching tool_result.
  for (const id of useIds) assert.ok(resultIds.has(id), `orphaned tool_use ${id} reached the API`);
  // Every tool_result must reference a surviving tool_use.
  for (const id of resultIds) assert.ok(useIds.has(id), `orphaned tool_result ${id} reached the API`);
  // Adjacency: EVERY tool_use in an assistant turn must have a tool_result in
  // the IMMEDIATELY following user message. Anthropic rejects the request with
  // HTTP 400 ("tool_use ids found without tool_result blocks immediately after")
  // if any tool_use's result lives in a later message.
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const useIdsHere = m.content.filter(b => b?.type === 'tool_use' && b.id).map(b => b.id);
    if (useIdsHere.length === 0) continue;
    const next = body.messages[i + 1];
    const nextResultIds = new Set();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content) if (b?.type === 'tool_result' && b.tool_use_id) nextResultIds.add(b.tool_use_id);
    }
    for (const id of useIdsHere) {
      assert.ok(nextResultIds.has(id), `tool_use ${id} has no tool_result in the immediately following message`);
    }
  }
  // First non-system message must be a user turn.
  assert.notEqual(body.messages.length, 0, 'messages array is empty');
  assert.equal(body.messages[0].role, 'user', 'first message is not a user turn');
}

// Safely collect content blocks of a given type across all messages (content
// may be a string for plain text turns, so guard with Array.isArray).
function blocksOfType(body, blockType, idField) {
  const out = [];
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === blockType && b[idField]) out.push(b[idField]);
  }
  return out;
}

test('drops a trailing assistant tool_use whose result never landed (abort path)', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_01_orphan', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ] },
    // NO matching tool_result here - simulates an interrupted turn.
    { role: 'user', content: 'next question' },
  ]);
  assertPairing(body);
  // The orphaned tool_use must be gone; the trailing user turn survives.
  const useIds = blocksOfType(body, 'tool_use', 'id');
  assert.equal(useIds.length, 0, 'orphaned tool_use was not stripped');
});

test('keeps a fully paired assistant tool_use + tool_result', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_01_ok', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_01_ok', name: 'bash', content: '{"ok":true}' },
    { role: 'user', content: 'thanks' },
  ]);
  assertPairing(body);
  const useIds = new Set(blocksOfType(body, 'tool_use', 'id'));
  assert.ok(useIds.has('call_01_ok'), 'paired tool_use was wrongly stripped');
});

test('repairs history corrupted by compaction (tool stripped, assistant kept)', async () => {
  // This is the exact shape compactMessages produced BEFORE the fix: the
  // `tool` role message was dropped, but the assistant tool_calls survived.
  const body = await captureRequestBody([
    { role: 'user', content: 'do work' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_01_lost', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } },
    ] },
    // tool_result was stripped by compaction -> would 400 without sanitization.
    { role: 'user', content: 'continue' },
  ]);
  assertPairing(body);
  const useIds = new Set(blocksOfType(body, 'tool_use', 'id'));
  assert.ok(!useIds.has('call_01_lost'), 'compaction-orphaned tool_use was not stripped');
});

test('drops an orphaned tool_result whose tool_use did not survive', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'sure' },
    // A tool_result with no preceding tool_use (reverse orphan).
    { role: 'tool', tool_call_id: 'call_99_ghost', name: 'bash', content: '{}' },
    { role: 'user', content: 'next' },
  ]);
  assertPairing(body);
  const resultIds = new Set(blocksOfType(body, 'tool_result', 'tool_use_id'));
  assert.ok(!resultIds.has('call_99_ghost'), 'orphaned tool_result was not stripped');
});

test('coalesces multi-tool-call results into one adjacent user turn (DeepSeek 400 regression)', async () => {
  // This is the exact shape the agent loop produces when an assistant turn
  // issues MULTIPLE tool calls: each result is its own role:'tool' message.
  // Before the fix the adapter emitted them as separate user turns, so the 2nd
  // tool_use had no tool_result in the immediately-following message and
  // Anthropic returned 400 "tool_use ids found without tool_result blocks
  // immediately after". The adapter must coalesce them into ONE user message.
  const body = await captureRequestBody([
    { role: 'user', content: 'do both' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_01_a', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
      { id: 'call_02_b', type: 'function', function: { name: 'read', arguments: '{"path":"b"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_01_a', name: 'read', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'call_02_b', name: 'read', content: '{"ok":true}' },
    { role: 'user', content: 'thanks' },
  ]);
  assertPairing(body);
  // Find the assistant turn with the tool_use blocks and assert the very next
  // message is a single user turn carrying BOTH tool_results.
  const asstIdx = body.messages.findIndex(m =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_use'));
  assert.notEqual(asstIdx, -1, 'assistant tool_use turn was dropped');
  const next = body.messages[asstIdx + 1];
  assert.ok(next && next.role === 'user' && Array.isArray(next.content), 'no user turn immediately after the tool_use turn');
  const resultIds = next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id);
  assert.deepEqual(resultIds.sort(), ['call_01_a', 'call_02_b'], 'tool_results were not coalesced into the immediately-following user message');
});

test('drops a tool_use whose result is non-adjacent (landed in a later message)', async () => {
  // Defense-in-depth for adjacency: a result that exists somewhere but not in
  // the immediately-next message must not keep its tool_use alive, or Anthropic
  // 400s on the gap.
  const body = await captureRequestBody([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_01_gap', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ] },
    // A plain user message sits between the tool_use and its result.
    { role: 'user', content: 'an interjection' },
    { role: 'tool', tool_call_id: 'call_01_gap', name: 'bash', content: '{}' },
    { role: 'user', content: 'done' },
  ]);
  assertPairing(body);
  const useIds = new Set(blocksOfType(body, 'tool_use', 'id'));
  assert.ok(!useIds.has('call_01_gap'), 'non-adjacent tool_use was not stripped');
});

/* ----------------------------------------------------------------------
 * Streaming-event tests: the tool_use / tool_result sanitization pass above
 * only covers the REQUEST body. The tests below cover the RESPONSE stream:
 *   - a tool_use block that never got a content_block_stop must still be
 *     yielded as a tool_call (otherwise plan_step is silently dropped and
 *     the live progress panel never advances)
 *   - a message_delta carrying input_tokens (Volcengine ark / glm-5.2) must
 *     surface a real input count so the status bar stops showing 0/estimate
 * ----------------------------------------------------------------------*/

async function collectStreamEvents(events) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _init) => makeRespWithEvents(events);
  const out = [];
  try {
    for await (const evt of streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      enableReasoning: false,
      timeoutMs: 1000,
    })) {
      out.push(evt);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return out;
}

test('flushes a tool_use that never received content_block_stop (plan_step not dropped)', async () => {
  // Simulates a stream that started a tool_use block, streamed its input_json
  // deltas, but then ended (message_stop) WITHOUT the closing
  // content_block_stop. This is the exact shape that would silently drop a
  // plan_step call: the agent loop would see zero pending tool calls and never
  // execute the step, leaving the progress panel stuck on in_progress.
  const events = [
    { event: 'message_start', data: { message: { usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { index: 0, content_block: { type: 'tool_use', id: 'call_planstep_1', name: 'plan_step', input: {} } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '{"step":' } } },
    { event: 'content_block_delta', data: { index: 0, delta: { type: 'input_json_delta', partial_json: '1}' } } },
    // NOTE: no content_block_stop for index 0.
    { event: 'message_delta', data: { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: {} },
  ];
  const out = await collectStreamEvents(events);
  const toolCalls = out.filter(e => e.type === 'tool_call');
  assert.equal(toolCalls.length, 1, 'tool_use without content_block_stop was dropped (plan_step would never run)');
  assert.equal(toolCalls[0].name, 'plan_step');
  assert.equal(toolCalls[0].id, 'call_planstep_1');
  assert.equal(toolCalls[0].arguments, '{"step":1}', 'accumulated input_json deltas were not assembled');
});

test('message_delta input_tokens surface as a real usage input (glm-5.2 via Volcengine)', async () => {
  // Volcengine ark reports input_tokens=0 in message_start and the real
  // input_tokens (e.g. 190) only in message_delta. The adapter must forward
  // it so the status bar shows the real input count instead of an estimate.
  const events = [
    { event: 'message_start', data: { message: { usage: { input_tokens: 0, output_tokens: 0 } } } },
    { event: 'message_delta', data: { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 190, output_tokens: 27 } } },
    { event: 'message_stop', data: {} },
  ];
  const out = await collectStreamEvents(events);
  const usages = out.filter(e => e.type === 'usage');
  // The message_delta usage must carry the real input count (190), not 0.
  const deltaUsage = usages.find(u => u.input === 190);
  assert.ok(deltaUsage, 'message_delta input_tokens (190) was not forwarded as a usage event');
  assert.equal(deltaUsage.output, 27, 'output_tokens from message_delta was lost');
});
