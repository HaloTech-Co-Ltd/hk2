/*-------------------------------------------------------------------------
 *
 * Mid-task user input: while an agent turn is running, the user may type
 * additional instructions. The in-flight action (LLM call / tool call)
 * completes first; the queued instructions are then delivered at the agent
 * loop's round boundary — after ALL tool_calls of the round finished, before
 * the next LLM call starts.
 *
 * Covered pieces:
 *   1. captureMidTaskInput   — REPL capture rule (enqueue interception)
 *   2. buildMidTaskInjection — batching queued lines into one tagged message
 *   3. flushMidTaskQueue     — leftovers returned to the normal queue
 *   4. runLoop(onRoundBoundary) — the boundary fires at the right time and
 *      the injected message is visible to the next LLM call
 *   5. Anthropic adapter     — a user turn injected right after tool results
 *      is coalesced into the tool_result turn (no "unexpected role user")
 *
 * Run:  node --test test/midtask_input.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { runLoop } from '../lib/agent/loop.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';
import { streamOpenAI } from '../lib/llm/openai_adapter.js';
import {
  createSession,
  captureMidTaskInput,
  buildMidTaskInjection,
  flushMidTaskQueue,
  disarmMidTaskCapture,
} from '../src/commands/interactive.js';

/* ── 1. captureMidTaskInput ───────────────────────────────────────────── */

test('capture: inactive turn never captures', () => {
  const s = createSession();
  s.agentTurnActive = false;
  assert.equal(captureMidTaskInput(s, 'hello'), false);
  assert.deepEqual(s.userInputQueue, []);
});

test('capture: active turn captures plain input, preserves order (FIFO)', () => {
  const s = createSession();
  s.agentTurnActive = true;
  assert.equal(captureMidTaskInput(s, 'first'), true);
  assert.equal(captureMidTaskInput(s, 'second'), true);
  assert.deepEqual(s.userInputQueue, ['first', 'second']);
});

test('capture: slash commands and blank lines are NOT captured', () => {
  const s = createSession();
  s.agentTurnActive = true;
  assert.equal(captureMidTaskInput(s, '/model list'), false);
  assert.equal(captureMidTaskInput(s, '   '), false);
  assert.equal(captureMidTaskInput(s, ''), false);
  assert.equal(captureMidTaskInput(s, null), false);
  assert.deepEqual(s.userInputQueue, []);
});

test('capture: slash command typed mid-task keeps legacy behavior (stays in session.queue)', async () => {
  // Simulate the enqueue() branch order: slash during active turn falls
  // through to the normal queue.
  const s = createSession();
  s.agentTurnActive = true;
  const line = '/model list';
  if (!captureMidTaskInput(s, line)) s.queue.push(line);
  assert.deepEqual(s.userInputQueue, []);
  assert.deepEqual(s.queue, ['/model list']);
});

/* ── 2. buildMidTaskInjection ─────────────────────────────────────────── */

test('injection: null for empty / blank-only input', () => {
  assert.equal(buildMidTaskInjection([]), null);
  assert.equal(buildMidTaskInjection(null), null);
  assert.equal(buildMidTaskInjection(['  ', '']), null);
});

test('injection: single line is included verbatim with guidance', () => {
  const out = buildMidTaskInjection(['also run the tests']);
  assert.ok(out.includes('also run the tests'));
  assert.match(out, /queued while the task was running/);
  assert.match(out, /do not restart from scratch/);
});

test('injection: multiple lines are batched into ONE message, order kept', () => {
  const out = buildMidTaskInjection(['use tabs not spaces', 'skip the docs']);
  assert.ok(out.includes('- use tabs not spaces'));
  assert.ok(out.includes('- skip the docs'));
  assert.ok(out.indexOf('use tabs not spaces') < out.indexOf('skip the docs'));
});

/* ── 3. flushMidTaskQueue ─────────────────────────────────────────────── */

test('flush: empty queue is a no-op', () => {
  const s = createSession();
  assert.deepEqual(flushMidTaskQueue(s), []);
  assert.deepEqual(s.queue, []);
});

test('flush: leftovers move to the FRONT of session.queue', () => {
  const s = createSession();
  s.queue = ['/model list'];
  s.userInputQueue = ['instr A', 'instr B'];
  const moved = flushMidTaskQueue(s);
  assert.deepEqual(moved, ['instr A', 'instr B']);
  // User instructions take priority over housekeeping slash commands.
  assert.deepEqual(s.queue, ['instr A', 'instr B', '/model list']);
  assert.deepEqual(s.userInputQueue, []);
});

test('disarm: early-cancel path disarms capture AND moves leftovers to session.queue', () => {
  // Regression: the clarification-cancel return exits runAgentTurn BEFORE
  // the main try/finally, so the old code left agentTurnActive = true forever
  // — enqueue() kept capturing (and silently swallowing) every subsequent
  // plain input. disarmMidTaskCapture is the shared exit guard.
  const s = createSession();
  s.agentTurnActive = true;
  s.userInputQueue = ['typed during cancelled turn'];
  disarmMidTaskCapture(s);
  assert.equal(s.agentTurnActive, false, 'capture must be disarmed');
  assert.deepEqual(s.queue, ['typed during cancelled turn'], 'leftover becomes a fresh user turn');
  assert.deepEqual(s.userInputQueue, []);
  // After disarm, captureMidTaskInput must refuse to capture (normal path).
  assert.equal(captureMidTaskInput(s, 'next line'), false);
});

test('disarm: idempotent — double disarm is a no-op', () => {
  const s = createSession();
  s.agentTurnActive = true;
  s.userInputQueue = ['x'];
  assert.deepEqual(disarmMidTaskCapture(s), ['x']);
  assert.deepEqual(disarmMidTaskCapture(s), []);
  assert.equal(s.agentTurnActive, false);
});

/* ── 4. runLoop round-boundary timing ─────────────────────────────────── */

// Minimal fake LLM whose script is a list of "responses": each entry is
// either { tool: {name, id, args} } (a tool_call round) or { text } (final).
// Records the messages array snapshot each call received.
function makeScriptedLlm(script) {
  const seenMessages = [];
  const llm = {
    async *stream(messages) {
      seenMessages.push(messages.map(m => ({ ...m })));
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      if (step.tool) {
        yield { type: 'tool_call', id: step.tool.id, name: step.tool.name, arguments: step.tool.args ?? '{}' };
      } else {
        yield { type: 'delta', text: step.text };
      }
    },
  };
  return { llm, seenMessages };
}

const passthroughTool = {
  name: 'noop',
  description: 'test tool',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true }),
};

test('runLoop: boundary fires after tools complete, before next LLM call', async () => {
  const { llm, seenMessages } = makeScriptedLlm([
    { tool: { name: 'noop', id: 't1' } },
    { tool: { name: 'noop', id: 't2' } },
    { text: 'done' },
  ]);
  const messages = [{ role: 'user', content: 'go' }];
  const events = [];

  const result = await runLoop({
    llm,
    messages,
    tools: [passthroughTool],
    onRoundBoundary: async (turnIdx) => { events.push(`boundary:${turnIdx}`); },
  });

  // Two tool rounds -> two boundary firings, each AFTER the tool result was
  // pushed and BEFORE the next llm.stream call read the array.
  assert.deepEqual(events, ['boundary:1', 'boundary:2']);
  assert.equal(result.turns, 3);

  // Call 2 (after first round) must see: user, assistant(tool_use t1), tool.
  const call2 = seenMessages[1].map(m => m.role);
  assert.deepEqual(call2, ['user', 'assistant', 'tool']);
  // Call 3 (after second round) additionally sees round 2's pairing.
  const call3 = seenMessages[2].map(m => m.role);
  assert.deepEqual(call3, ['user', 'assistant', 'tool', 'assistant', 'tool']);
  // The final text-only round does NOT fire another boundary (loop returned).
});

test('runLoop: instruction injected at the boundary is visible to the next LLM call', async () => {
  const { llm, seenMessages } = makeScriptedLlm([
    { tool: { name: 'noop', id: 't1' } },
    { text: 'adjusted' },
  ]);
  const messages = [{ role: 'user', content: 'original task' }];

  await runLoop({
    llm,
    messages,
    tools: [passthroughTool],
    onRoundBoundary: async () => {
      messages.push({ role: 'user', content: buildMidTaskInjection(['use tabs']) });
    },
  });

  const call2 = seenMessages[1];
  assert.equal(call2[call2.length - 1].role, 'user');
  assert.ok(call2[call2.length - 1].content.includes('use tabs'));
  // ...and it sits AFTER the tool result of round 1 (legal position).
  assert.equal(call2[2].role, 'tool');
});

test('runLoop: text-only final answer returns without firing a boundary', async () => {
  const { llm } = makeScriptedLlm([{ text: 'all done' }]);
  let fired = 0;
  await runLoop({
    llm,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [passthroughTool],
    onRoundBoundary: async () => { fired++; },
  });
  assert.equal(fired, 0);
});

test('runLoop: no onRoundBoundary callback — zero change to legacy behavior', async () => {
  const { llm, seenMessages } = makeScriptedLlm([
    { tool: { name: 'noop', id: 't1' } },
    { text: 'done' },
  ]);
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runLoop({ llm, messages, tools: [passthroughTool] });
  assert.equal(res.turns, 2);
  assert.equal(seenMessages[1].length, 3);
});

/* ── 5. Adapter handling of the injected message shape ────────────────── */

/*
 * Both adapters must accept the message shape mid-task injection produces:
 *   ... user, assistant(tool_calls), tool, user(«injected instruction») ...
 * (the injected user turn sits right after the tool result), plus the plain
 * consecutive-user shape. Anthropic coalesces these into one turn; OpenAI
 * tolerates them natively and must pass them through UNTOUCHED (no merging,
 * no reordering, tools still forwarded).
 */

// Stub fetch, capture the request body, return a minimal valid SSE stream.
function sseBody() {
  return [
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ].join('');
}

async function captureRequestBody(messages) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => '',
      // Real ReadableStream: consumeSSE reads via getReader(), and a body
      // read failure is now SURFACED (and retried) instead of silently
      // ending the stream — a mock without getReader would throw.
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseBody()));
          controller.close();
        },
      }),
    };
  };
  try {
    for await (const _evt of streamAnthropic({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages, maxChars: 8192, enableReasoning: false, timeoutMs: 1000,
    })) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  return captured;
}

test('adapter: user message injected after tool results is coalesced into the tool_result turn', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'run the suite' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'bash', content: '{"ok":true}' },
    // ← injected mid-task at the round boundary:
    { role: 'user', content: buildMidTaskInjection(['also lint the files']) },
  ]);
  // No two consecutive user turns may reach the API.
  for (let i = 1; i < body.messages.length; i++) {
    assert.ok(!(body.messages[i].role === 'user' && body.messages[i - 1].role === 'user'),
      `consecutive user turns at ${i}`);
  }
  // The mid-task text rode along with the tool_result turn as a text block.
  const resultTurn = body.messages.find(m =>
    m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result'));
  assert.ok(resultTurn, 'tool_result turn present');
  const textBlock = resultTurn.content.find(b => b?.type === 'text');
  assert.ok(textBlock, 'merged text block present');
  assert.ok(textBlock.text.includes('also lint the files'));
});

test('adapter: consecutive plain user turns merge into one (string concat)', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
  ]);
  const users = body.messages.filter(m => m.role === 'user');
  assert.equal(users.length, 1);
  assert.ok(String(users[0].content).includes('first'));
  assert.ok(String(users[0].content).includes('second'));
});

test('adapter: alternating history is untouched by coalescing', async () => {
  const body = await captureRequestBody([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ]);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'user']);
});

/* ── 6. OpenAI adapter: injected shape passes through untouched ───────── */

async function captureOpenAIBody(messages, tools) {
  let captured = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true, status: 200,
      text: async () => '',
      // Real ReadableStream: consumeSSE reads via getReader(), and a body
      // read failure is now SURFACED (and retried) instead of silently
      // ending the stream — a mock without getReader would throw.
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
    };
  };
  try {
    for await (const _evt of streamOpenAI({
      baseUrl: 'https://example.com', apiKey: 'k', model: 'm',
      messages, tools, maxChars: 8192, enableReasoning: false, timeoutMs: 1000,
    })) { /* drain */ }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(captured, 'fetch was not called');
  return captured;
}

const openAITools = [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } } }];

test('openai adapter: user turn injected after tool result passes through untouched', async () => {
  const injected = buildMidTaskInjection(['also lint the files']);
  const messages = [
    { role: 'user', content: 'run the suite' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', name: 'bash', content: '{"ok":true}' },
    // ← injected mid-task at the round boundary:
    { role: 'user', content: injected },
  ];
  const body = await captureOpenAIBody(messages, openAITools);
  // Exact passthrough: same length, same order, identical contents.
  assert.equal(body.messages.length, 4);
  assert.deepEqual(body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'user']);
  assert.equal(body.messages[3].content, injected);
  assert.equal(body.messages[2].tool_call_id, 't1');
  // Tool forwarding still intact on this path.
  assert.equal(body.tools[0].function.name, 'bash');
  assert.equal(body.tool_choice, 'auto');
});

test('openai adapter: consecutive plain user turns pass through untouched', async () => {
  const messages = [
    { role: 'user', content: 'first task' },
    { role: 'user', content: buildMidTaskInjection(['and then deploy']) },
  ];
  const body = await captureOpenAIBody(messages);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].content.includes('and then deploy'), true);
});
