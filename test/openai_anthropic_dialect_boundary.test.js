/*-------------------------------------------------------------------------
 *
 * Regression tests: dialect boundary between the OpenAI-compatible and the
 * Anthropic Messages adapters, around modelOptions.tools (server-side
 * built-in tool declarations like web_search / web_fetch).
 *
 * Incident: the KB entry claimed that configuring
 *   --model-options='{"tools":[{"type":"web_search_20250305"},...]}'
 * makes the request body carry the built-in declarations, enabling
 * server-side web access without curl/wget. That is true ONLY for the
 * Anthropic dialect (lib/llm/anthropic_adapter.js merges modelOptions.tools
 * into body.tools). The OpenAI adapter SILENTLY DROPPED the key: a DeepSeek
 * (openai-dialect) model configured this way never received any built-in
 * declaration and truthfully refused real-time fetch tasks — the user was
 * left believing server-side tools were active.
 *
 * Fixed contract:
 *   1. openai_adapter: modelOptions.tools (non-empty array) THROWS a
 *      fail-loud error explaining the dialect boundary, BEFORE any HTTP
 *      traffic. OpenAI is OpenAI, Anthropic is Anthropic — never mixed.
 *   2. anthropic_adapter: invalid passthrough keys that LOOK like official
 *      parameters are dropped from the body but now yield a 'notice' stream
 *      event BEFORE any HTTP traffic (previously computed and silently
 *      discarded — dead code).
 *   3. runLoop forwards 'notice' events to callbacks.onNotice so the UI can
 *      display them (covered here at the adapter level; turn.js wiring uses
 *      the same optional-callback pattern as onRetry).
 *
 * Run:  node --test test/openai_anthropic_dialect_boundary.test.js
 *-----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { streamOpenAI } from '../lib/llm/openai_adapter.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';

/* ---------------------------------------------------------------- helpers */

let networkCalls = 0;

function makeResp(openai) {
  // A minimal completed stream in the dialect requested by the adapter.
  const sse = openai ? 'data: [DONE]\n\n' : [
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
    'event: message_stop\ndata: {}\n\n',
  ].join('');
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: {
      [Symbol.asyncIterator]: async function* () { yield enc.encode(sse); },
      getReader() {
        let pushed = false;
        return {
          read: async () => {
            if (pushed) return { done: true, value: undefined };
            pushed = true;
            return { done: false, value: enc.encode(sse) };
          },
        };
      },
    },
  };
}

/** Replace globalThis.fetch with a probe; return {restore, requests, events}. */
function installFetchProbe() {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    networkCalls++;
    requests.push(JSON.parse(init.body));
    return makeResp(_url.includes('/chat/completions'));
  };
  return {
    requests,
    restore() { globalThis.fetch = originalFetch; },
    async drain(gen) {
      const events = [];
      for await (const evt of gen) events.push(evt);
      return events;
    },
  };
}

/* ----------------------------------------------------------------- tests */

test('openai: modelOptions.tools (built-in declarations) throws before any HTTP traffic', async () => {
  const probe = installFetchProbe();
  try {
    await assert.rejects(
      () => probe.drain(streamOpenAI({
        baseUrl: 'https://example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        maxChars: 8192,
        modelOptions: { tools: [{ type: 'web_search_20250305' }] },
      })),
      (err) => {
        assert.match(err.message, /Anthropic Messages API/);
        assert.match(err.message, /--api=anthropic/);
        return true;
      },
    );
    assert.equal(probe.requests.length, 0, 'no HTTP request may leave the adapter');
    assert.equal(networkCalls, 0);
  } finally {
    probe.restore();
  }
});

test('openai: empty modelOptions.tools array stays allowed (clearing a config)', async () => {
  const probe = installFetchProbe();
  try {
    await probe.drain(streamOpenAI({
      baseUrl: 'anthropic-to-openai-gateway.example',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      modelOptions: { tools: [] },
    }));
    assert.equal(probe.requests.length, 1);
    assert.equal(probe.requests[0].tools, undefined, 'no tools key synthesized from an empty declaration');
  } finally {
    probe.restore();
  }
});

test('openai: modelOptions without a tools key is unaffected', async () => {
  const probe = installFetchProbe();
  try {
    await probe.drain(streamOpenAI({
      baseUrl: 'https://example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      modelOptions: { reasoning_effort: 'low' },
    }));
    assert.equal(probe.requests.length, 1);
  } finally {
    probe.restore();
  }
});

test('anthropic: invalid passthrough key yields a notice event before HTTP traffic', async () => {
  const probe = installFetchProbe();
  try {
    const events = await probe.drain(streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      modelOptions: { stop_sequences: [42] },   // invalid: non-string entry
    }));
    const notices = events.filter(e => e.type === 'notice');
    assert.ok(notices.length > 0, 'a notice event was yielded');
    assert.match(notices[0].message, /stop_sequences/);
    assert.match(notices[0].message, /ignored/);
    // The invalid value never reached the request body:
    assert.equal(probe.requests[0].stop_sequences, undefined);
    // Notice precedes the request: the first yielded event is the notice.
    assert.equal(events[0].type, 'notice');
  } finally {
    probe.restore();
  }
});

test('anthropic: valid passthrough emits no notice event', async () => {
  const probe = installFetchProbe();
  try {
    const events = await probe.drain(streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      modelOptions: { stop_sequences: ['END.'] },
    }));
    assert.equal(events.filter(e => e.type === 'notice').length, 0);
    assert.deepEqual(probe.requests[0].stop_sequences, ['END.']);
  } finally {
    probe.restore();
  }
});

test('anthropic: modelOptions.tools success yields a positive-declaration notice before HTTP traffic', async () => {
  // Observability: the model owner must be able to SEE that an EXPLICIT
  // built-in declaration actually reached the request body. (The default
  // declarations are quiet by design — builtinTools:false here isolates the
  // notice behavior under test from them.)
  const probe = installFetchProbe();
  try {
    const events = await probe.drain(streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      builtinTools: false,
      modelOptions: { tools: [{ type: 'web_search_20250305' }, { type: 'web_fetch_20250910' }] },
    }));
    const notices = events.filter(e => e.type === 'notice');
    assert.equal(notices.length, 1, 'exactly one notice (the declaration confirmation)');
    assert.match(notices[0].message, /built-in tools declared/);
    assert.match(notices[0].message, /web_search_20250305/);
    assert.match(notices[0].message, /web_fetch_20250910/);
    // The confirmation precedes the HTTP request: first yielded event.
    assert.equal(events[0].type, 'notice');
    // And the body actually carries the declarations:
    assert.equal(probe.requests[0].tools.length, 2);
    assert.equal(probe.requests[0].tools[0].type, 'web_search_20250305');
    assert.equal(probe.requests[0].tools[1].type, 'web_fetch_20250910');
  } finally {
    probe.restore();
  }
});

test('anthropic: near-miss built-in family name yields a warning notice, nothing merged', async () => {
  // {"type":"web_search"} LOOKS like a built-in but carries no dated suffix;
  // silently dropping it re-creates the declaration gap — the drop must be
  // audible, with the recognized dated variants listed.
  const probe = installFetchProbe();
  try {
    const events = await probe.drain(streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      builtinTools: false,
      modelOptions: { tools: [{ type: 'web_search' }] },
    }));
    const notices = events.filter(e => e.type === 'notice');
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /"web_search" is not a recognized built-in/);
    assert.match(notices[0].message, /web_search_20250305/);
    // Nothing was merged into the body:
    assert.equal(probe.requests[0].tools, undefined);
  } finally {
    probe.restore();
  }
});

test('anthropic: genuine custom-tool entries stay silent (no near-miss noise)', async () => {
  // {type:'function', function:{...}} is a client-registry tool misplaced in
  // modelOptions — dropped wholesale, but it doesn't LOOK like a built-in
  // family, so no warning noise. builtinTools:false isolates the notice
  // behavior from the quiet default declarations.
  const probe = installFetchProbe();
  try {
    const events = await probe.drain(streamAnthropic({
      baseUrl: 'https://example.com',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxChars: 8192,
      builtinTools: false,
      modelOptions: { tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] },
    }));
    assert.equal(events.filter(e => e.type === 'notice').length, 0);
    assert.equal(probe.requests[0].tools, undefined);
  } finally {
    probe.restore();
  }
});
