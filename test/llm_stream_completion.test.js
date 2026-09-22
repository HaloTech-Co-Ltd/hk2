import test from 'node:test';
import assert from 'node:assert/strict';
import { streamOpenAI } from '../lib/llm/openai_adapter.js';
import { streamAnthropic } from '../lib/llm/anthropic_adapter.js';

const data = obj => `data: ${JSON.stringify(obj)}\n\n`;
const event = (name, obj) => `event: ${name}\n${data(obj)}`;
const dialects = [
  {
    name: 'OpenAI', stream: streamOpenAI,
    text: data({ choices: [{ delta: { content: 'partial reply' } }] }),
    tool: data({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call_1', function: { name: 'write', arguments: '{"path":"a.txt","content":"x"}' } },
    ] } }] }),
    reason: data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    terminal: 'data: [DONE]\n\n',
  },
  {
    name: 'Anthropic', stream: streamAnthropic,
    text: event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'partial reply' } }),
    tool: event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'write', input: {} } })
      + event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","content":"x"}' } })
      + event('content_block_stop', { index: 1 }),
    reason: event('message_delta', { delta: { stop_reason: 'tool_use' } }),
    terminal: event('message_stop', {}),
  },
];

async function consume(dialect, body, events, { signal, onEvent } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  try {
    for await (const evt of dialect.stream({
      baseUrl: 'http://unused.test/v1', apiKey: 'test', model: 'test',
      messages: [{ role: 'user', content: 'test' }], timeoutMs: 0, signal,
      builtinTools: false,
    })) {
      events.push(evt);
      onEvent?.(evt);
    }
  } finally {
    globalThis.fetch = original;
  }
}

for (const dialect of dialects) {
  test(`${dialect.name} rejects normal EOF without model completion`, async () => {
    for (const body of ['', dialect.text, dialect.text + dialect.tool]) {
      const events = [];
      await assert.rejects(consume(dialect, body, events), /request failed: incomplete stream/);
      assert.ok(events.every(e => !['finish', 'done', 'tool_call'].includes(e.type)));
    }
  });

  test(`${dialect.name} accepts explicit completion before releasing tool calls`, async () => {
    for (const ending of [dialect.reason, dialect.terminal, dialect.reason + dialect.terminal]) {
      for (const crlf of [false, true]) {
        let body = dialect.text + dialect.tool + ending;
        if (crlf) body = body.replace(/\n/g, '\r\n');
        const events = [];
        await consume(dialect, body, events);
        const calls = events.filter(e => e.type === 'tool_call');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'write');
        assert.deepEqual(JSON.parse(calls[0].arguments), { path: 'a.txt', content: 'x' });
        assert.deepEqual(events.slice(-2).map(e => e.type), ['finish', 'done']);
      }
    }
  });

  test(`${dialect.name} cancellation does not report completion or release tools`, async () => {
    const controller = new AbortController();
    const events = [];
    await consume(dialect, dialect.text + dialect.tool + dialect.terminal, events, {
      signal: controller.signal,
      onEvent: e => { if (e.type === 'delta') controller.abort(); },
    });
    assert.ok(events.some(e => e.type === 'delta'));
    assert.ok(events.every(e => !['finish', 'done', 'tool_call'].includes(e.type)));
  });
}
