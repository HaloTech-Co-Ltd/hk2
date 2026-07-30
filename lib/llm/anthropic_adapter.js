/**
 * Anthropic-style adapter: POST ${baseUrl}/v1/messages
 *
 * Accepted message shapes (mixed with OpenAI style):
 *   - {role:'system'|'user'|'assistant', content}
 *   - {role:'assistant', tool_calls:[{id, function:{name, arguments}}]}
 *   - {role:'tool', tool_call_id, content}
 * Stream output (generator):
 *   { type:'delta', text }
 *   { type:'reasoning', text }
 *   { type:'tool_call', id, name, arguments }
 *   { type:'finish', reason }
 *   { type:'done' }
 */

import { consumeSSE } from './sse.js';

export async function* streamAnthropic({ baseUrl, apiKey, model, messages, maxChars, temperature, enableReasoning, timeoutMs, signal, tools, headers }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  // Extract system message
  let system = '';
  const userAssistant = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n' : '') + m.content;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      // OpenAI-style assistant tool_calls → Anthropic content blocks
      const blocks = [];
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input;
        try { input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
        catch { input = {}; }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input,
        });
      }
      userAssistant.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      // OpenAI-style tool result → Anthropic tool_result block
      userAssistant.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || {}),
        }],
      });
    } else {
      userAssistant.push({ role: m.role, content: m.content });
    }
  }

  const charBudget = maxChars || 65536;
  // When thinking is enabled, budget_tokens is DEDUCTED from max_tokens by the
  // Anthropic API. So max_tokens must be strictly greater than budget_tokens,
  // leaving room for the actual text answer. We split: 40% for thinking,
  // 60% for text (both capped to API limits).
  const thinkingBudget = Math.min(16000, Math.floor(charBudget / 4 * 0.4));
  const textBudget = Math.min(64000, Math.max(4096, Math.floor(charBudget / 4 * 0.6)));
  const totalMaxTokens = thinkingBudget + textBudget;

  const body = {
    model,
    messages: userAssistant,
    stream: true,
    system: system || undefined,
    max_tokens: totalMaxTokens,
    // Anthropic requires temperature=1 when thinking is enabled; otherwise the
    // API silently returns empty content. Only apply the caller's temperature
    // when thinking is off.
    temperature: (enableReasoning !== false) ? 1 : (temperature ?? 0.2),
  };
  if (enableReasoning !== false) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.parameters,
    }));
  }

  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs || 600000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason));

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream',
        ...(headers || {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    throw new Error(`Anthropic request failed: ${err.message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    clearTimeout(timeoutHandle);
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 500)}`);
  }

  // Aggregate tool_use blocks by index
  const pending = new Map();   // index → {id, name, input:''}
  let finishReason = null;

  try {
    for await (const evt of iterateStream(resp)) {
      if (evt.type === 'delta') yield evt;
      else if (evt.type === 'reasoning') yield evt;
      else if (evt.type === 'usage') yield evt;
      else if (evt.type === 'tool_use_start') {
        pending.set(evt.index, { id: evt.id, name: evt.name, input: '' });
      } else if (evt.type === 'tool_use_delta') {
        const cur = pending.get(evt.index);
        if (cur) cur.input += evt.delta;
      } else if (evt.type === 'tool_use_stop') {
        const cur = pending.get(evt.index);
        if (cur) {
          yield { type: 'tool_call', id: cur.id, name: cur.name, arguments: cur.input };
          pending.delete(evt.index);
        }
      } else if (evt.type === 'finish') {
        finishReason = evt.reason;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  yield { type: 'finish', reason: finishReason || 'stop' };
  yield { type: 'done' };
}

async function* iterateStream(resp) {
  for await (const evt of consumeStreamAsync(resp)) {
    if (evt.event === 'message_stop') {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    if (evt.event === 'message_start') {
      // Contains message.usage with input_tokens (and cache stats)
      let json;
      try { json = JSON.parse(evt.data); } catch { continue; }
      const u = json.message?.usage;
      if (u) {
        yield {
          type: 'usage',
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
          cache_creation: u.cache_creation_input_tokens ?? 0,
        };
      }
      continue;
    }
    if (evt.event === 'message_delta') {
      let json;
      try { json = JSON.parse(evt.data); } catch { continue; }
      // Final output_tokens count comes in the message_delta's usage field
      const u = json.usage;
      if (u && typeof u.output_tokens === 'number') {
        yield { type: 'usage', input: 0, output: u.output_tokens };
      }
      const reason = json.delta?.stop_reason;
      if (reason) yield { type: 'finish', reason };
      continue;
    }
    if (evt.event !== 'content_block_start' && evt.event !== 'content_block_delta' && evt.event !== 'content_block_stop') continue;
    let json;
    try { json = JSON.parse(evt.data); } catch { continue; }
    if (evt.event === 'content_block_start' && json.content_block?.type === 'tool_use') {
      yield {
        type: 'tool_use_start',
        index: json.index,
        id: json.content_block.id,
        name: json.content_block.name,
      };
    } else if (evt.event === 'content_block_start' && json.content_block?.type === 'thinking') {
      // thinking block start; subsequent deltas arrive via thinking_delta
    } else if (evt.event === 'content_block_delta') {
      const d = json.delta;
      if (!d) continue;
      if (d.type === 'text_delta' && d.text) yield { type: 'delta', text: d.text };
      else if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
      else if (d.type === 'input_json_delta' && d.partial_json) {
        // Forward to the tool_use block at this index (already started)
        yield { type: 'tool_use_delta', index: json.index, delta: d.partial_json };
      }
    } else if (evt.event === 'content_block_stop') {
      const idx = json.index;
      yield { type: 'tool_use_stop', index: idx };
    }
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
