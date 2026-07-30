/**
 * OpenAI-style adapter: POST ${baseUrl}/v1/chat/completions
 *
 * Accepted message shapes:
 *   - {role:'system'|'user'|'assistant', content}
 *   - {role:'assistant', tool_calls: [{id, type:'function', function:{name, arguments}}]}
 *   - {role:'tool', tool_call_id, content}
 *
 * Stream (async generator) yields unified events:
 *   { type: 'delta', text }                       body text chunk
 *   { type: 'reasoning', text }                   reasoning chunk (e.g. GLM-4.7 reasoning_content)
 *   { type: 'tool_call', id, name, arguments }    one fully-assembled tool call (emitted after stream ends)
 *   { type: 'finish', reason }                    finish ('stop' | 'tool_calls' | 'length')
 *   { type: 'done' }                              generator end
 */

import { consumeSSE } from './sse.js';

export async function* streamOpenAI({ baseUrl, apiKey, model, messages, maxChars, temperature, enableReasoning, timeoutMs, signal, tools, headers }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    temperature: temperature ?? 0.2,
    stream_options: { include_usage: true },
  };
  if (maxChars) body.max_tokens = Math.min(32768, Math.max(256, Math.floor(maxChars / 4)));
  if (enableReasoning === false) {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs || 600000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason));

  let resp;
  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'text/event-stream',
    };
    if (headers) Object.assign(reqHeaders, headers);
    resp = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw new Error(`OpenAI request failed: ${err.message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    clearTimeout(timeoutHandle);
    throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 500)}`);
  }

  // Aggregate tool_calls by index
  const pendingToolCalls = new Map();   // index → {id, name, arguments}
  let finishReason = null;

  try {
    for await (const evt of iterateStream(resp)) {
      if (evt.type === 'delta') yield evt;
      else if (evt.type === 'reasoning') yield evt;
      else if (evt.type === 'usage') yield evt;
      else if (evt.type === 'tool_call_delta') {
        const idx = evt.index;
        let cur = pendingToolCalls.get(idx);
        if (!cur) {
          cur = { id: evt.id || `call_${idx}`, name: '', arguments: '' };
          pendingToolCalls.set(idx, cur);
        }
        if (evt.id) cur.id = evt.id;
        if (evt.name) cur.name = cur.name + evt.name;
        if (evt.argsDelta) cur.arguments = cur.arguments + evt.argsDelta;
      } else if (evt.type === 'finish') {
        finishReason = evt.reason;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Emit aggregated tool_call events
  const sortedIdx = Array.from(pendingToolCalls.keys()).sort((a, b) => a - b);
  for (const idx of sortedIdx) {
    const tc = pendingToolCalls.get(idx);
    yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments };
  }
  yield { type: 'finish', reason: finishReason || 'stop' };
  yield { type: 'done' };
}

async function* iterateStream(resp) {
  for await (const evt of consumeStreamAsync(resp)) {
    if (evt.data === '[DONE]') return;
    let json;
    try { json = JSON.parse(evt.data); } catch { continue; }
    // Usage chunk: when include_usage=true, OpenAI sends a final chunk with
    // choices: [] and a top-level `usage` object. Emit before skipping.
    if (json.usage) {
      yield {
        type: 'usage',
        input: json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
        output: json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
        cache_read: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
        total: json.usage.total_tokens ?? 0,
      };
    }
    const choice = json.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) yield { type: 'delta', text: delta.content };
    if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
    if (delta.reasoning) yield { type: 'reasoning', text: delta.reasoning };
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        yield {
          type: 'tool_call_delta',
          index: typeof tc.index === 'number' ? tc.index : 0,
          id: tc.id || null,
          name: tc.function?.name || '',
          argsDelta: tc.function?.arguments || '',
        };
      }
    }
    if (choice.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
  }
}

async function* consumeStreamAsync(resp) {
  const events = [];
  let resolve;
  let waitPromise = new Promise(r => { resolve = r; });
  let done = false;

  consumeSSE(resp.body, (evt) => {
    events.push(evt);
    resolve();
    waitPromise = new Promise(r => { resolve = r; });
  }, () => {
    done = true;
    resolve();
  }).catch(err => {
    done = true;
    events.push({ __error: err });
    resolve();
  });

  while (true) {
    if (events.length > 0) {
      yield events.shift();
    } else if (done) {
      return;
    } else {
      await waitPromise;
    }
  }
}

export async function completeOpenAI({ baseUrl, apiKey, model, messages, maxChars, temperature, timeoutMs, headers }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages,
    stream: false,
    temperature: temperature ?? 0.2,
  };
  if (maxChars) body.max_tokens = Math.min(32768, Math.max(256, Math.floor(maxChars / 4)));

  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), timeoutMs || 600000);

  try {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    if (headers) Object.assign(reqHeaders, headers);
    const resp = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = await resp.json();
    return json.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeoutHandle);
  }
}
