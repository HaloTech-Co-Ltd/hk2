/*-------------------------------------------------------------------------
 * Regression tests for issues #3 and #4 (agent loop correctness).
 *
 * #3 — executeToolCall wrapped every non-throwing tool return in ok:true,
 *      including the dominant `{ error: <string> }` failure style (~60 call
 *      sites), AND runLoop cached those failed envelopes in the per-run tool
 *      cache, pinning transient errors for the whole run. Fixed: a result
 *      whose ONLY own field is `error` becomes { ok:false, error } (results
 *      with extra fields keep their shape), and only ok:true results enter
 *      the cache.
 *
 * #4 — replayTranscript coalesced ALL consecutive tool_call events into one
 *      synthesized assistant.tool_calls message, erasing the round structure
 *      of sequential rounds. Fixed: runLoop stamps each call with `round`,
 *      logToolCall persists it, and replay groups by round (one assistant
 *      message per round). Transcripts without `round` keep the legacy
 *      coalescing behavior (backward compatible).
 *
 * Run:  node --test test/tool_error_contract.test.js
 *-----------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeToolCall } from '../lib/agent/tools.js';
import { runLoop } from '../lib/agent/loop.js';
import { replayTranscript } from '../lib/agent/transcript.js';

// ---- #3: envelope semantics ---------------------------------------------

function tool(name, fn) {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute: async (args) => fn(args) };
}

test('a tool returning pure {error} maps to ok:false with the error preserved', async () => {
  const tools = [tool('kb_callchain', () => ({ error: 'symbol_id required' }))];
  const env = await executeToolCall(tools, { name: 'kb_callchain', arguments: '{}' });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'symbol_id required');
  assert.equal(env.result, undefined);
});

test('a result carrying error PLUS other fields keeps ok:true (partial success)', async () => {
  const tools = [tool('resolve', () => ({ error: 'file x skipped', applied: 1, files: ['a'] }))];
  const env = await executeToolCall(tools, { name: 'resolve', arguments: '{}' });
  assert.equal(env.ok, true);
  assert.equal(env.result.applied, 1);
  assert.equal(env.result.error, 'file x skipped');
});

test('a thrown tool error still maps to ok:false (unchanged throw path)', async () => {
  const tools = [tool('boom', () => { throw new Error('exploded'); })];
  const env = await executeToolCall(tools, { name: 'boom', arguments: '{}' });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'exploded');
});

test('a normal result still maps to ok:true', async () => {
  const tools = [tool('read', () => ({ path: '/x', lines: ['a'] }))];
  const env = await executeToolCall(tools, { name: 'read', arguments: '{}' });
  assert.equal(env.ok, true);
  assert.equal(env.result.path, '/x');
});

// ---- #3: cache behavior ---------------------------------------------------

function fakeLLM(script) {
  let i = 0;
  return {
    stream() {
      if (i >= script.length) throw new Error('fakeLLM script exhausted');
      const step = script[i++];
      let queue = [];
      let text = '';
      if (Array.isArray(step)) {
        queue = step.map((c, k) => ({ type: 'tool_call', id: `call_${i}_${k}`, name: c.name, arguments: c.arguments }));
      } else {
        text = String(step);
      }
      return {
        async *[Symbol.asyncIterator]() {
          if (text) yield { type: 'delta', text };
          for (const q of queue) yield q;
        },
      };
    },
  };
}

test('failed cacheable calls are NOT cached — a same-args retry re-executes', async () => {
  let executions = 0;
  const tools = [tool('kb_symbol', () => {
    executions++;
    return executions < 2 ? { error: 'knowledge graph not built' } : { name: 'found' };
  })];
  const llm = fakeLLM([
    [{ name: 'kb_symbol', arguments: '{"name":"x"}' }],
    [{ name: 'kb_symbol', arguments: '{"name":"x"}' }], // same args: would hit the cache pre-fix
    'done',
  ]);
  const messages = [];
  const res = await runLoop({ llm, messages, tools });
  assert.equal(res.lastText, 'done');
  assert.equal(executions, 2); // pre-fix: 1 (cached failure served round 2)
  // The model saw the error in round 1 and the success in round 2.
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /knowledge graph not built/);
  assert.match(toolMsgs[1].content, /found/);
});

test('successful cacheable calls still hit the cache (no behavior change)', async () => {
  let executions = 0;
  const tools = [tool('kb_symbol', () => { executions++; return { name: 'found' }; })];
  const llm = fakeLLM([
    [{ name: 'kb_symbol', arguments: '{"name":"x"}' }],
    [{ name: 'kb_symbol', arguments: '{"name":"x"}' }],
    'done',
  ]);
  await runLoop({ llm, messages: [], tools });
  assert.equal(executions, 1); // second identical call served from cache
});

// ---- #4: round-stamped replay ---------------------------------------------

test('replay groups round-stamped sequential calls into separate assistant messages', () => {
  const lines = [
    JSON.stringify({ ts: 't0', type: 'user', text: 'go' }),
    // Round 1: one call
    JSON.stringify({ ts: 't1', type: 'tool_call', id: 'a', name: 'read', arguments: '{"path":"f1"}', result: { path: 'f1' }, ok: true, round: 1 }),
    // Round 2: one call DEPENDING on round 1's result
    JSON.stringify({ ts: 't2', type: 'tool_call', id: 'b', name: 'read', arguments: '{"path":"f2"}', result: { path: 'f2' }, ok: true, round: 2 }),
    // Round 3: two PARALLEL calls in the same round
    JSON.stringify({ ts: 't3', type: 'tool_call', id: 'c', name: 'grep', arguments: '{"pattern":"x"}', result: { count: 0 }, ok: true, round: 3 }),
    JSON.stringify({ ts: 't4', type: 'tool_call', id: 'd', name: 'find', arguments: '{"pattern":"y"}', result: { files: [] }, ok: true, round: 3 }),
    JSON.stringify({ ts: 't5', type: 'assistant', text: 'all done' }),
  ].join('\n');
  const { messages } = replayTranscript(lines);
  const assistants = messages.filter((m) => m.role === 'assistant' && m.tool_calls);
  // 3 rounds → 3 separate assistant.tool_calls messages, order preserved.
  assert.equal(assistants.length, 3);
  assert.deepEqual(assistants[0].tool_calls.map((t) => t.id), ['a']);
  assert.deepEqual(assistants[1].tool_calls.map((t) => t.id), ['b']);
  assert.deepEqual(assistants[2].tool_calls.map((t) => t.id), ['c', 'd']);
  // Tool results interleave per round: a | b | c d — never b before a.
  const ids = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
});

test('replay of legacy transcripts (no round field) keeps the coalescing behavior', () => {
  const lines = [
    JSON.stringify({ ts: 't0', type: 'user', text: 'go' }),
    JSON.stringify({ ts: 't1', type: 'tool_call', id: 'a', name: 'read', arguments: '{}', result: {}, ok: true }),
    JSON.stringify({ ts: 't2', type: 'tool_call', id: 'b', name: 'read', arguments: '{}', result: {}, ok: true }),
    JSON.stringify({ ts: 't3', type: 'tool_call', id: 'c', name: 'read', arguments: '{}', result: {}, ok: true }),
  ].join('\n');
  const { messages } = replayTranscript(lines);
  const assistants = messages.filter((m) => m.role === 'assistant' && m.tool_calls);
  // Legacy: all consecutive tool_calls coalesce into ONE message.
  assert.equal(assistants.length, 1);
  assert.equal(assistants[0].tool_calls.length, 3);
});

test('replay handles mixed legacy + round-stamped events (legacy groups forward)', () => {
  const lines = [
    JSON.stringify({ ts: 't1', type: 'tool_call', id: 'a', name: 'read', arguments: '{}', result: {}, ok: true }),          // legacy, no round
    JSON.stringify({ ts: 't2', type: 'tool_call', id: 'b', name: 'read', arguments: '{}', result: {}, ok: true, round: 2 }), // stamped
    JSON.stringify({ ts: 't3', type: 'tool_call', id: 'c', name: 'read', arguments: '{}', result: {}, ok: true, round: 2 }),
  ].join('\n');
  const { messages } = replayTranscript(lines);
  const assistants = messages.filter((m) => m.role === 'assistant' && m.tool_calls);
  // 'a' (no round) groups by itself; the two round-2 calls share one message.
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants[0].tool_calls.map((t) => t.id), ['a']);
  assert.deepEqual(assistants[1].tool_calls.map((t) => t.id), ['b', 'c']);
});

test('runLoop stamps executed calls with their round index', async () => {
  const seen = [];
  const tools = [tool('kb_symbol', () => ({ name: 'x' }))];
  const llm = fakeLLM([
    [{ name: 'kb_symbol', arguments: '{}' }],
    [{ name: 'kb_symbol', arguments: '{"n":2}' }],
    'done',
  ]);
  await runLoop({
    llm, messages: [], tools,
    callbacks: { onToolCallEnd: (call) => seen.push(call.round) },
  });
  assert.deepEqual(seen, [1, 2]);
});
