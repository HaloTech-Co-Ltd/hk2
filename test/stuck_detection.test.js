/**
 * Stuck-detection regression tests for lib/agent/loop.js.
 *
 * Bug being guarded against: the detector compared only the tool-call
 * SIGNATURE across rounds. plan_step is stateful by design — the callback
 * ignores the model's step number and always advances the current step —
 * so a legitimate catch-up burst of plan_step {"step":8} x3 (marking steps
 * 2→3→4 after an interruption resume) was false-flagged as "agent stuck:
 * 3 identical tool-call rounds in a row (no progress)". Observed live in
 * session 67ebd5d8 (2026-08-26).
 *
 * Fix (option 1): a round counts as no-progress only when BOTH the call
 * signature AND the result fingerprint repeat. Different results = the
 * stateful tool is advancing = progress.
 *
 * These tests drive runLoop with a scripted fake LLM stream, so the whole
 * loop machinery (assistant push, tool exec, cache, detection) runs for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../lib/agent/loop.js';

/**
 * Build a fake LLM whose stream() replays a script of assistant turns.
 * Each script entry: either a string (plain text turn → loop returns) or
 * an array of tool_calls [{ name, arguments }] for that round.
 */
function fakeLLM(script) {
  let i = 0;
  return {
    stream(messages) {
      if (i >= script.length) throw new Error('fakeLLM script exhausted — loop ran past the scripted rounds');
      const step = script[i];
      i++;
      let queue = [];
      let text = '';
      if (Array.isArray(step)) {
        queue = step.map((c, k) => ({ type: 'tool_call', id: `call_${i}_${k}`, name: c.name, arguments: c.arguments }));
      } else {
        text = String(step);
      }
      const self = {
        async *[Symbol.asyncIterator]() {
          if (text) yield { type: 'delta', text };
          for (const q of queue) yield q;
        },
      };
      return self;
    },
  };
}

/** Registry of fake tools; each entry: name → fn(args) → result object. */
function fakeTools(registry) {
  return Object.entries(registry).map(([name, fn]) => ({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async (args) => fn(args),
  }));
}

test('stateful tool: identical signatures with DIFFERENT results = progress, no abort', async () => {
  // Reproduces the exact live sequence: model passes step:8 every round,
  // the callback advances the real current step (2 → 3 → 4 → ... → done).
  let current = 2; // steps 0,1 already done when the plan was resumed
  const ROUNDS = 7;
  const llm = fakeLLM([
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    'done - all steps marked',
  ]);
  const tools = fakeTools({
    plan_step: () => {
      const marked = current;
      current++;
      return { ok: true, message: `Marked plan step ${marked} as done.` };
    },
  });
  const messages = [{ role: 'user', content: 'resume' }];
  const res = await runLoop({ llm, messages, tools });
  assert.equal(res.toolCalls, ROUNDS, 'all identical-signature rounds executed — no false abort');
  assert.equal(current, 2 + ROUNDS, 'callback advanced one step per round');
  assert.ok(String(messages.at(-1).content).includes('done'));
});

test('stateless tool: identical signature AND identical result x3 → still aborts', async () => {
  const llm = fakeLLM([
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    'unreachable',
  ]);
  const tools = fakeTools({
    read: () => ({ content: 'same deterministic content' }),
  });
  await assert.rejects(
    () => runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools }),
    /agent stuck: 3 identical tool-call rounds with identical results/,
  );
});

test('stateful tool: identical signature AND identical RESULT x3 (no state change) → still aborts', async () => {
  // A stateful-looking tool that keeps returning the same message is NOT
  // making progress either — the fix must not weaken the genuine guard.
  const llm = fakeLLM([
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }],
    'unreachable',
  ]);
  const tools = fakeTools({
    plan_step: () => ({ ok: true, message: 'No active plan - plan_step ignored.' }),
  });
  await assert.rejects(
    () => runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools }),
    /agent stuck: 3 identical tool-call rounds with identical results/,
  );
});

test('mixed signature change resets the counter (alternating signatures never trip)', async () => {
  const llm = fakeLLM([
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    [{ name: 'read', arguments: '{"path":"b.txt"}' }],
    [{ name: 'read', arguments: '{"path":"a.txt"}' }],
    [{ name: 'read', arguments: '{"path":"b.txt"}' }],
    'finished',
  ]);
  const tools = fakeTools({
    read: (args) => ({ content: `content of ${args.path}` }),
  });
  const res = await runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools });
  assert.equal(res.toolCalls, 4);
});

test('error results participate in the fingerprint: same error x3 → aborts', async () => {
  const llm = fakeLLM([
    [{ name: 'kb_symbol', arguments: '{"name":"ghost"}' }],
    [{ name: 'kb_symbol', arguments: '{"name":"ghost"}' }],
    [{ name: 'kb_symbol', arguments: '{"name":"ghost"}' }],
    [{ name: 'kb_symbol', arguments: '{"name":"ghost"}' }],
    'unreachable',
  ]);
  const tools = fakeTools({
    kb_symbol: () => { throw new Error('not found: ghost'); },
  });
  await assert.rejects(
    () => runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools }),
    /agent stuck: 3 identical tool-call rounds with identical results/,
  );
});

test('multi-call rounds: fingerprint covers ALL calls of the round', async () => {
  // Same plan_step signature, but the round also contains a changing second
  // call → combined fingerprint differs → progress. (Also exercises the
  // per-round signature SORT: [plan_step, read] vs [read, plan_step] order
  // must produce the same key.)
  let n = 0;
  const llm = fakeLLM([
    [{ name: 'plan_step', arguments: '{"step":8}' }, { name: 'probe', arguments: '{"n":1}' }],
    [{ name: 'probe', arguments: '{"n":2}' }, { name: 'plan_step', arguments: '{"step":8}' }],
    [{ name: 'plan_step', arguments: '{"step":8}' }, { name: 'probe', arguments: '{"n":3}' }],
    'ok',
  ]);
  const tools = fakeTools({
    plan_step: () => { n++; return { ok: true, message: `Marked plan step ${n} as done.` }; },
    probe: (a) => ({ probe: a.n }),
  });
  const res = await runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools });
  assert.equal(res.toolCalls, 6);
});
