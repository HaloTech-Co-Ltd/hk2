/**
 * Stuck-detection regression tests for lib/agent/loop.js.
 *
 * Bug being guarded against (TWO incidents, same defect class):
 *
 *  (1) 2026-08-26 — the detector compared only the tool-call SIGNATURE, so a
 *      legitimate catch-up burst of plan_step {"step":8} x3 (each call truly
 *      advancing state) was false-flagged. Fixed by also fingerprinting the
 *      RESULTS.
 *
 *  (2) The incident this file now guards: the trigger response was a THROW —
 *      `bash|{"command":"sleep 55; psql ..."}` repeated x4 (polling a
 *      PostgreSQL restart that legitimately wasn't up yet) killed the ENTIRE
 *      task with "agent stuck". A misbehaving or failing tool must NEVER
 *      terminate the agent loop on its own; the detector's job is to correct
 *      the model, not to kill the task.
 *
 * Fix (2): the 4th identical signature+result round now injects a progressive
 * CORRECTIVE system message (root-cause / change wait strategy / stop and
 * answer) and resets the repeat window. Only after the whole nudge budget
 * (HK2_STUCK_NUDGE_LIMIT, default 10) is exhausted without escape does the
 * detector abort. Real progress (any different signature or result) re-arms
 * the full budget.
 *
 * These tests drive runLoop with a scripted fake LLM stream, so the whole
 * loop machinery (assistant push, tool exec, cache, detection) runs for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop, stuckNudgeLimit, buildStuckNudgeText } from '../lib/agent/loop.js';

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

/** N identical single-call rounds, then a scripted escape round + final text. */
function identicalRounds(n, call) {
  return Array.from({ length: n }, () => [{ ...call }]);
}

test('stateful tool: identical signatures with DIFFERENT results = progress, no abort, no nudge', async () => {
  // Reproduces the 2026-08-26 live sequence: model passes step:8 every round,
  // the callback advances the real current step (2 → 3 → 4 → ... → done).
  let current = 2; // steps 0,1 already done when the plan was resumed
  const ROUNDS = 7;
  const llm = fakeLLM([
    ...identicalRounds(ROUNDS, { name: 'plan_step', arguments: '{"step":8}' }),
    'done - all steps marked',
  ]);
  const nudges = [];
  const tools = fakeTools({
    plan_step: () => {
      const marked = current;
      current++;
      return { ok: true, message: `Marked plan step ${marked} as done.` };
    },
  });
  const messages = [{ role: 'user', content: 'resume' }];
  const res = await runLoop({ llm, messages, tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });
  assert.equal(res.toolCalls, ROUNDS, 'all identical-signature rounds executed — no false abort');
  assert.equal(current, 2 + ROUNDS, 'callback advanced one step per round');
  assert.equal(nudges.length, 0, 'advancing results never trigger a nudge');
  assert.ok(String(messages.at(-1).content).includes('done'));
});

test('INCIDENT REPRO: repeated bash poll gets nudged, escapes, task completes — never aborts', async () => {
  // The exact live shape: the model polls `sleep 55; psql ... start_time`
  // while PostgreSQL restarts. Rounds 1-4 return the identical start_time
  // (bash is NOT cacheable, so it genuinely re-executes). Round 4 trips the
  // detector → corrective nudge injected. The model then changes strategy
  // (one longer wait) and finishes. Old code: hard abort at round 4.
  const poll = { name: 'bash', arguments: '{"command":"sleep 55; psql -p 5432 -d gbtree -Atc \\"select pg_postmaster_start_time()\\" 2>&1 | head -1"}' };
  let calls = 0;
  const tools = fakeTools({
    bash: (a) => {
      calls++;
      // Deterministic identical results across the 4 poll rounds, then the
      // different final command naturally returns different content.
      if (a.command?.includes('pg_postmaster_start_time')) return { exitCode: 0, stdout: '2026-09-01 00:00:00 UTC' };
      return { exitCode: 0, stdout: 'restarted' };
    },
  });
  const llm = fakeLLM([
    ...identicalRounds(4, poll),
    [{ name: 'bash', arguments: '{"command":"sleep 120; psql -p 5432 -d gbtree -Atc \\"select pg_postmaster_start_time()\\" 2>&1 | head -1","timeout":150}' }], // escaped: different signature
    'PostgreSQL restarted; start_time confirmed updated.',
  ]);
  const nudges = [];
  const messages = [{ role: 'user', content: 'wait for the restart and confirm' }];
  const res = await runLoop({ llm, messages, tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });

  assert.equal(res.toolCalls, 5);
  assert.equal(nudges.length, 1, 'exactly one nudge at the 4th identical round');
  assert.equal(nudges[0].nudgeNo, 1);
  assert.ok(nudges[0].signature.startsWith('bash|'), 'signature names the repeated call');
  // The corrective message is IN the conversation the model saw.
  const sysNudges = messages.filter((m) => m.role === 'system' && String(m.content).includes('Loop correction'));
  assert.equal(sysNudges.length, 1);
  assert.match(sysNudges[0].content, /poll is not ready yet|WAIT LONGER IN ONE CALL/i);
  assert.ok(String(messages.at(-1).content).includes('restarted') || String(messages.at(-1).content).includes('PostgreSQL'));
});

test('stateless tool: identical signature AND result — nudged with a fresh grace window, escapes after nudge', async () => {
  // Old code aborted at round 4. Now round 4 nudges AND RESETS the repeat
  // counter; the model repeats twice more (still within the grace window),
  // then escapes and completes.
  const call = { name: 'read', arguments: '{"path":"a.txt"}' };
  const tools = fakeTools({ read: () => ({ content: 'same deterministic content' }) });
  const llm = fakeLLM([
    ...identicalRounds(6, call), // rounds 1-4: trip + nudge at 4; rounds 5-6: new window
    [{ name: 'read', arguments: '{"path":"b.txt"}' }],
    'done',
  ]);
  const nudges = [];
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runLoop({ llm, messages, tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });
  assert.equal(res.toolCalls, 7);
  assert.equal(nudges.length, 1, 'nudge fires once; grace window absorbs rounds 5-6');
  assert.equal(nudges[0].repeats, 3);
});

test('genuine infinite loop: nudges escalate 1..N then abort — the guard still exists', async () => {
  // A model that NEVER escapes: every round identical forever. The detector
  // nudges nudgeLimit times (escalating), then aborts with the new message.
  // Budget=2 keeps the script small. Rounds per window: 3 repeats after the
  // initial → nudge at rounds 4, 8; abort at round 12.
  const limit = 2;
  process.env.HK2_STUCK_NUDGE_LIMIT = String(limit);
  try {
    const call = { name: 'read', arguments: '{"path":"a.txt"}' };
    const tools = fakeTools({ read: () => ({ content: 'same deterministic content' }) });
    const llm = fakeLLM(identicalRounds(13, call).concat(['unreachable']));
    const nudges = [];
    await assert.rejects(
      () => runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } }),
      /agent stuck: 3 repeated identical tool-call rounds .* and 2 corrective nudges were ignored/,
    );
    assert.equal(nudges.length, limit);
    assert.deepEqual(nudges.map((n) => n.nudgeNo), [1, 2]);
  } finally {
    delete process.env.HK2_STUCK_NUDGE_LIMIT;
  }
});

test('default nudge budget is 10 (HK2_STUCK_NUDGE_LIMIT unset → 10 nudges before abort)', async () => {
  const saved = process.env.HK2_STUCK_NUDGE_LIMIT;
  delete process.env.HK2_STUCK_NUDGE_LIMIT;
  try {
    assert.equal(stuckNudgeLimit(), 10);
  } finally {
    if (saved !== undefined) process.env.HK2_STUCK_NUDGE_LIMIT = saved;
  }
  // Explicit 0 restores legacy fail-fast: the first trigger (round 4) aborts.
  process.env.HK2_STUCK_NUDGE_LIMIT = '0';
  try {
    const call = { name: 'read', arguments: '{"path":"a.txt"}' };
    const tools = fakeTools({ read: () => ({ content: 'same' }) });
    const llm = fakeLLM(identicalRounds(5, call).concat(['unreachable']));
    await assert.rejects(
      () => runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools }),
      /agent stuck: 3 repeated identical tool-call rounds .* and 0 corrective nudges were ignored/,
    );
  } finally {
    if (saved !== undefined) process.env.HK2_STUCK_NUDGE_LIMIT = saved;
    else delete process.env.HK2_STUCK_NUDGE_LIMIT;
  }
});

test('real progress RE-ARMS the nudge budget: escape → new loop gets a full budget again', async () => {
  // Loop A trips and is nudged once, escapes; loop B (different call) also
  // trips and is nudged from scratch — nudges reset on progress, so a long
  // task with several recoverable stalls is never penalized for earlier ones.
  process.env.HK2_STUCK_NUDGE_LIMIT = '1';
  try {
    const tools = fakeTools({
      read: (a) => ({ content: `content of ${a.path}` }),
      grep: () => ({ count: 0, matches: [] }), // always identical within its own loop
    });
    const llm = fakeLLM([
      ...identicalRounds(4, { name: 'read', arguments: '{"path":"a.txt"}' }), // loop A trips
      [{ name: 'read', arguments: '{"path":"c.txt"}' }],                       // escape (progress)
      ...identicalRounds(4, { name: 'grep', arguments: '{"pattern":"zzz"}' }), // loop B trips
      [{ name: 'grep', arguments: '{"pattern":"yyy"}' }],                      // escape
      'finished both investigations',
    ]);
    const nudges = [];
    const messages = [{ role: 'user', content: 'go' }];
    const res = await runLoop({ llm, messages, tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });
    assert.equal(res.toolCalls, 10);
    assert.equal(nudges.length, 2, 'budget re-armed after each escape: both loops nudged exactly once');
    assert.deepEqual(nudges.map((n) => n.nudgeNo), [1, 1], 'each new loop starts from nudge 1');
  } finally {
    delete process.env.HK2_STUCK_NUDGE_LIMIT;
  }
});

test('nudge text is progressive: 1/N vs FINAL escalation, includes the signature and break options', () => {
  const first = buildStuckNudgeText('bash|{"command":"ls"}', 1, 10);
  assert.match(first, /1\/10/);
  assert.ok(!/FINAL/.test(first));
  assert.match(first, /bash\|\{"command":"ls"\}/);
  assert.match(first, /ROOT CAUSE|root.?cause/i);
  assert.match(first, /WAIT LONGER IN ONE CALL/i);
  assert.match(first, /STOP calling tools and answer/i);

  const last = buildStuckNudgeText('read|{"path":"x"}', 10, 10);
  assert.match(last, /FINAL corrective notice \(10\/10\)/);
  assert.match(last, /aborted/);

  // Very long signatures are truncated, not dropped.
  const long = buildStuckNudgeText('bash|' + 'x'.repeat(1000), 1, 10);
  assert.ok(long.length < 2000);
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
  const nudges = [];
  const res = await runLoop({ llm, messages: [{ role: 'user', content: 'go' }], tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });
  assert.equal(res.toolCalls, 4);
  assert.equal(nudges.length, 0);
});

test('error results participate in the fingerprint: same error keeps looping → nudged like any other repeat', async () => {
  // A persistently failing call is the same defect class: correct it, don't
  // kill the task. One window trips, the nudge lands, the model changes args
  // (error text changes with them) and the task completes.
  const tools = fakeTools({
    kb_symbol: (a) => { throw new Error(`not found: ${a.name}`); },
  });
  const llm = fakeLLM([
    ...identicalRounds(4, { name: 'kb_symbol', arguments: '{"name":"ghost"}' }),
    [{ name: 'kb_symbol', arguments: '{"name":"other"}' }],
    'done',
  ]);
  const nudges = [];
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runLoop({ llm, messages, tools, callbacks: { onStuckNudge: (i) => nudges.push(i) } });
  assert.equal(res.toolCalls, 5);
  assert.equal(nudges.length, 1);
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /not found: ghost/);
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
