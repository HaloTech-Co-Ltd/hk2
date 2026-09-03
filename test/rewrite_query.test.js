/*-------------------------------------------------------------------------
 *
 * Unit tests for lib/retrieval/rewrite_query.js - the LLM-driven query rewrite
 * and request-clarity assessment. The pure helpers (coerceStringArray,
 * extractJsonObject, fallback) are module-private; we exercise them through
 * the public rewriteQuery / assessRequest entry points with a fake LLM whose
 * `stream()` yields canned deltas.
 *
 * Run:  node --test test/rewrite_query.test.js
 *----------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert';
import { rewriteQuery, assessRequest } from '../lib/retrieval/rewrite_query.js';

// A fake LLM: llm.stream(messages, opts) is an async generator that yields
// { type: 'delta', text } events concatenated into the raw model output. This
// mirrors what lib/retrieval/rewrite_query.js :: callLlm consumes.
function fakeLlm(raw) {
  return {
    stream: async function* () {
      // Yield the canned string in one delta (callLlm concatenates deltas).
      yield { type: 'delta', text: raw };
    },
  };
}

// A fake LLM whose stream throws (simulates a network / timeout error).
function throwingLlm(err = new Error('boom')) {
  return {
    stream: async function* () { throw err; },
  };
}

// A fake LLM that yields nothing (empty stream).
function emptyLlm() {
  return {
    stream: async function* () { /* no deltas */ },
  };
}

/* ------------------------------- rewriteQuery --------------------------- */

test('rewriteQuery parses a well-formed JSON response into structured fields', async () => {
  const llm = fakeLlm(JSON.stringify({
    intent: 'find function',
    functionNames: ['parseConfig', 'loadModels'],
    keywords: ['config', 'models'],
  }));
  const out = await rewriteQuery(llm, 'how do I parse the config');
  assert.equal(out.fallback, false);
  assert.equal(out.intent, 'find function');
  assert.deepEqual(out.functionNames, ['parseConfig', 'loadModels']);
  assert.deepEqual(out.keywords, ['config', 'models']);
  assert.equal(out.originalQuery, 'how do I parse the config');
  assert.equal(out.rewrittenQuery, 'parseConfig loadModels config models');
});

test('rewriteQuery extracts JSON embedded in prose (extractJsonObject fallback)', async () => {
  const llm = fakeLlm(`Sure, here is the rewrite:\n{"intent":"x","functionNames":["foo"],"keywords":["bar"]}\nDone.`);
  const out = await rewriteQuery(llm, 'foo the bar');
  assert.equal(out.fallback, false);
  assert.equal(out.intent, 'x');
  assert.deepEqual(out.functionNames, ['foo']);
  assert.deepEqual(out.keywords, ['bar']);
});

test('rewriteQuery falls back when the LLM returns non-JSON garbage', async () => {
  const llm = fakeLlm('I do not understand the request.');
  const out = await rewriteQuery(llm, 'something weird');
  assert.equal(out.fallback, true);
  assert.equal(out.rewrittenQuery, 'something weird');
  assert.equal(out.originalQuery, 'something weird');
  assert.deepEqual(out.functionNames, []);
  assert.deepEqual(out.keywords, []);
});

test('rewriteQuery falls back to original when rewrittenQuery is empty', async () => {
  // functionNames + keywords both empty -> rewrittenQuery is '' -> fallback.
  const llm = fakeLlm(JSON.stringify({ intent: 'vague', functionNames: [], keywords: [] }));
  const out = await rewriteQuery(llm, 'do a thing');
  assert.equal(out.fallback, true);
  assert.equal(out.rewrittenQuery, 'do a thing');
  assert.equal(out.intent, 'vague');
});

test('rewriteQuery coerces non-string / duplicate array items (coerceStringArray)', async () => {
  const llm = fakeLlm(JSON.stringify({
    intent: '',
    functionNames: ['foo', 42, null, 'foo', '  ', 'bar'],
    keywords: ['baz'],
  }));
  const out = await rewriteQuery(llm, 'x');
  assert.deepEqual(out.functionNames, ['foo', 'bar']);
  assert.deepEqual(out.keywords, ['baz']);
});

test('rewriteQuery falls back on LLM stream error (defensive)', async () => {
  const out = await rewriteQuery(throwingLlm(), 'real query');
  assert.equal(out.fallback, true);
  assert.equal(out.rewrittenQuery, 'real query');
  // Transport failures must NOT be silent: the reason is surfaced via `error`
  // so callers can warn + apply the phase-model fallback policy.
  assert.match(out.error, /boom/);
});

test('rewriteQuery falls back on empty stream', async () => {
  const out = await rewriteQuery(emptyLlm(), 'real query');
  assert.equal(out.fallback, true);
  assert.equal(out.rewrittenQuery, 'real query');
});

test('rewriteQuery falls back immediately for empty / whitespace query (no LLM call)', async () => {
  let calls = 0;
  const llm = { stream: async function* () { calls++; yield { type: 'delta', text: '{}' }; } };
  let out = await rewriteQuery(llm, '');
  assert.equal(out.fallback, true);
  out = await rewriteQuery(llm, '   \n\t  ');
  assert.equal(out.fallback, true);
  assert.equal(calls, 0, 'LLM must not be called for an empty query');
});

test('rewriteQuery forwards a clarification as an extra user message', async () => {
  let seenMessages = null;
  const llm = {
    stream: async function* (messages) {
      seenMessages = messages;
      yield { type: 'delta', text: JSON.stringify({ intent: 'x', functionNames: ['f'], keywords: ['k'] }) };
    },
  };
  await rewriteQuery(llm, 'do the thing', { clarification: 'I meant the config thing' });
  // 3 messages: system, user(query), user(clarification).
  assert.equal(seenMessages.length, 3);
  assert.ok(seenMessages[2].content.includes('Clarification from the user'));
  assert.ok(seenMessages[2].content.includes('I meant the config thing'));
});

/* ------------------------------- assessRequest ------------------------- */

test('assessRequest returns clear:true for a clear LLM verdict', async () => {
  const llm = fakeLlm(JSON.stringify({ clear: true }));
  const out = await assessRequest(llm, 'read src/index.js');
  assert.equal(out.clear, true);
  assert.deepEqual(out.unclear, []);
  assert.deepEqual(out.interpretations, []);
});

test('assessRequest returns clear:false with interpretations when LLM says unclear', async () => {
  const llm = fakeLlm(JSON.stringify({
    clear: false,
    unclear: ['which module?'],
    interpretations: ['module A', 'module B'],
  }));
  const out = await assessRequest(llm, 'fix the module');
  assert.equal(out.clear, false);
  assert.deepEqual(out.unclear, ['which module?']);
  assert.deepEqual(out.interpretations, ['module A', 'module B']);
});

test('assessRequest treats missing/true/null clear as clear (fail-open)', async () => {
  const llm = fakeLlm(JSON.stringify({}));
  let out = await assessRequest(llm, 'do something');
  assert.equal(out.clear, true);
  const llm2 = fakeLlm(JSON.stringify({ clear: null }));
  out = await assessRequest(llm2, 'do something');
  assert.equal(out.clear, true);
});

test('assessRequest falls back to clear when LLM returns non-JSON', async () => {
  const llm = fakeLlm('cannot parse');
  const out = await assessRequest(llm, 'something');
  assert.equal(out.clear, true);
});

test('assessRequest with no interpretations is treated as clear (avoid dead-end)', async () => {
  const llm = fakeLlm(JSON.stringify({ clear: false, interpretations: [] }));
  const out = await assessRequest(llm, 'vague');
  assert.equal(out.clear, true, 'unclear with nothing to offer must not dead-end the user');
});

test('assessRequest falls back to clear on LLM stream error', async () => {
  const out = await assessRequest(throwingLlm(), 'real query');
  assert.equal(out.clear, true);
  // Transport failures must NOT be silent: the reason is surfaced via `error`
  // so callers can warn + apply the phase-model fallback policy.
  assert.match(out.error, /boom/);
});

test('assessRequest returns clear:true immediately for empty / whitespace query', async () => {
  let calls = 0;
  const llm = { stream: async function* () { calls++; yield { type: 'delta', text: '{}' }; } };
  let out = await assessRequest(llm, '');
  assert.equal(out.clear, true);
  out = await assessRequest(llm, '   \n\t  ');
  assert.equal(out.clear, true);
  assert.equal(calls, 0, 'LLM must not be called for an empty query');
});

test('assessRequest forwards retrieved context as an extra user message', async () => {
  let seenMessages = null;
  const llm = {
    stream: async function* (messages) {
      seenMessages = messages;
      yield { type: 'delta', text: JSON.stringify({ clear: true }) };
    },
  };
  await assessRequest(llm, 'do the thing', { context: 'found symbol foo in bar.js' });
  // P0-3 order: system, user(KB context), user(query LAST).
  assert.equal(seenMessages.length, 3);
  assert.ok(seenMessages[1].content.includes('Retrieved knowledge-base context'));
  assert.ok(seenMessages[1].content.includes('found symbol foo in bar.js'));
  assert.ok(seenMessages[2].content.includes("The user's request to assess"));
  assert.ok(seenMessages[2].content.includes('do the thing'));
});

test('assessRequest forwards session context BEFORE KB context, query LAST (P0-3 order)', async () => {
  let seenMessages = null;
  const llm = {
    stream: async function* (messages) {
      seenMessages = messages;
      yield { type: 'delta', text: JSON.stringify({ clear: true }) };
    },
  };
  await assessRequest(llm, 'fix it', {
    sessionContext: 'In-flight task: refactor the plan-progress module',
    context: 'Summary: matched buildResumeContext',
  });
  // 4 messages: system, user(session context), user(KB context), user(query).
  assert.equal(seenMessages.length, 4);
  assert.ok(seenMessages[1].content.includes('Current session context'));
  assert.ok(seenMessages[1].content.includes('refactor the plan-progress module'));
  assert.ok(seenMessages[2].content.includes('Retrieved knowledge-base context'));
  assert.ok(seenMessages[3].content.includes("The user's request to assess"));
  assert.ok(seenMessages[3].content.includes('fix it'));
});

test('assessRequest omits empty/whitespace session context', async () => {
  let seenMessages = null;
  const llm = {
    stream: async function* (messages) {
      seenMessages = messages;
      yield { type: 'delta', text: JSON.stringify({ clear: true }) };
    },
  };
  await assessRequest(llm, 'fix it', { sessionContext: '   \n  ' });
  assert.equal(seenMessages.length, 2, 'no session-context message when digest is empty');
});

test('assessRequest parses followup/confidence/reason and downgrades low-confidence unclear (P0-3)', async () => {
  // Full verdict with the new fields round-trips.
  const ok = fakeLlm(JSON.stringify({
    clear: true, followup: true, confidence: 0.95,
    reason: 'session context pins the referent',
  }));
  let out = await assessRequest(ok, '执行下一步');
  assert.equal(out.clear, true);
  assert.equal(out.followup, true);
  assert.equal(out.confidence, 0.95);
  assert.equal(out.reason, 'session context pins the referent');

  // High-confidence unclear survives.
  const sure = fakeLlm(JSON.stringify({
    clear: false, confidence: 0.93,
    unclear: ['which module?'],
    interpretations: ['module A', 'module B'],
  }));
  out = await assessRequest(sure, 'fix the module');
  assert.equal(out.clear, false);
  assert.equal(out.confidence, 0.93);

  // Low-confidence unclear is DOWNGRADED to clear (burden-of-proof asymmetry).
  const unsure = fakeLlm(JSON.stringify({
    clear: false, confidence: 0.5,
    unclear: ['which module?'],
    interpretations: ['module A', 'module B'],
  }));
  out = await assessRequest(unsure, 'fix the module');
  assert.equal(out.clear, true, 'low-confidence unclear must not interrupt the user');
  assert.match(out.reason, /low confidence/);

  // Missing confidence defaults to 1 (trust the verdict).
  const noco = fakeLlm(JSON.stringify({
    clear: false, unclear: ['which module?'], interpretations: ['module A', 'module B'],
  }));
  out = await assessRequest(noco, 'fix the module');
  assert.equal(out.clear, false);
});

test('assessRequest honors HK2_ASSESS_MIN_CONFIDENCE threshold override (P0-3)', async () => {
  const prev = process.env.HK2_ASSESS_MIN_CONFIDENCE;
  try {
    process.env.HK2_ASSESS_MIN_CONFIDENCE = '0.3';
    const unsure = fakeLlm(JSON.stringify({
      clear: false, confidence: 0.5,
      unclear: ['which module?'], interpretations: ['module A', 'module B'],
    }));
    const out = await assessRequest(unsure, 'fix the module');
    assert.equal(out.clear, false, '0.5 confidence survives a 0.3 threshold');
  } finally {
    if (prev === undefined) delete process.env.HK2_ASSESS_MIN_CONFIDENCE;
    else process.env.HK2_ASSESS_MIN_CONFIDENCE = prev;
  }
});

test('assessRequest: HK2_ASSESS_REASONING=1 enables reasoning on the call (P2)', async () => {
  let seenOpts = null;
  const llm = {
    stream: async function* (_messages, opts) {
      seenOpts = opts;
      yield { type: 'delta', text: JSON.stringify({ clear: true }) };
    },
  };
  const prev = process.env.HK2_ASSESS_REASONING;
  try {
    delete process.env.HK2_ASSESS_REASONING;
    await assessRequest(llm, 'do it');
    assert.equal(seenOpts.enableReasoning, false, 'reasoning off by default');
    process.env.HK2_ASSESS_REASONING = '1';
    await assessRequest(llm, 'do it');
    assert.equal(seenOpts.enableReasoning, true, 'HK2_ASSESS_REASONING=1 turns it on');
  } finally {
    if (prev === undefined) delete process.env.HK2_ASSESS_REASONING;
    else process.env.HK2_ASSESS_REASONING = prev;
  }
});
