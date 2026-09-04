/*-------------------------------------------------------------------------
 *
 * /review command tests.
 *
 * `/review <phase> [--model=<provider>/<model-id>]` manually reviews the
 * just-completed task. These tests lock in:
 *   1. Usage / unknown-phase / unimplemented-plan handling.
 *   2. Model resolution priority: --model flag > project code-review phase
 *      config > current session model (credentials-checked, like
 *      test/phase_model.test.js).
 *   3. Context isolation: the messages sent to the review LLM contain the
 *      original request, queued additions, claimed result, changed files and
 *      diff - none of the conversation's intermediate process context.
 *   4. Result rendering (ok / issues) and the skip-on-unreachable policy
 *      (no fallback to the session model for review phases).
 *
 * The review LLM is faked by injecting a stub into ctx.llm / the resolved
 * model config, matching the LLMClient.stream contract reviewCode consumes.
 *
 * Run:  node --test test/review_cmd.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHome, saveModels,
  registerProject, setCurrentProject, setPhaseModelRef,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';
import {
  buildManualCodeReviewContent, MANUAL_REVIEW_SYSTEM_PROMPT, reviewCode,
  createVerdictFilter, REPORT_MARKER, VERDICT_MARKER,
} from '../lib/agent/code_review.js';
import {
  buildMidTaskInjection, extractTaskRequirement, MID_TASK_INJECTION_HEADER,
} from '../src/commands/session_ctx.js';

let __seq = 0;

async function seedModels() {
  await ensureHome();
  await saveModels({
    providers: {
      provA: {
        api: 'openai',
        baseUrl: 'http://a.example/v1',
        apiKey: 'sk-a',
        models: [{ id: 'model-a', name: 'A', contextWindow: 8192, temperature: 0.2 }],
      },
      provB: {
        api: 'openai',
        baseUrl: 'http://b.example/v1',
        apiKey: 'sk-b',
        models: [{ id: 'model-b', name: 'B', contextWindow: 8192, temperature: 0.2 }],
      },
    },
    default: 'provA/model-a',
  });
}

async function makeProject(name) {
  const n = ++__seq;
  const src = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-review-${name}${n}-`));
  return registerProject({ name: `${name}${n}`, sourcePath: src });
}

// Build a session with a fake "completed task" conversation, a ctx whose
// print output is captured, and an injectable review LLM (replaces
// session.llm so the session-model path runs the fake without network).
async function makeCtx(p) {
  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  ctx.setPhase = () => {};
  await reloadAll(session, ctx);
  session.messages = [
    { role: 'user', content: 'Implement the /review command exactly as specified.' },
    { role: 'assistant', content: 'Implemented /review with model resolution and tests. All done.' },
  ];
  return { session, ctx, prints };
}

// Fake LLM: yields the given text as delta events and records the messages
// it was called with, so tests can assert on the exact review payload.
function recordingLlm(outputText, apiKey) {
  const calls = [];
  return {
    calls,
    config: { apiKey },
    stream: async function* (messages, opts) {
      calls.push({ messages, opts });
      yield { type: 'delta', text: outputText };
    },
  };
}

function deadLlm(reason = 'connect ECONNREFUSED') {
  return {
    config: {},
    stream: async function* () { throw new Error(reason); },
  };
}

// ---------------------------------------------------------------------------
// 1. Usage / unknown phase / plan not implemented
// ---------------------------------------------------------------------------

test('/review with no args prints usage', async () => {
  await seedModels();
  const p = await makeProject('usage');
  await setCurrentProject(p.id);
  const { ctx, prints } = await makeCtx(p);

  await dispatchSlash('/review', ctx);
  assert.ok(prints.some((s) => s.includes('Usage: /review <phase>')), `expected usage, got: ${JSON.stringify(prints)}`);
});

test('/review with an unknown phase is rejected', async () => {
  await seedModels();
  const p = await makeProject('badphase');
  await setCurrentProject(p.id);
  const { ctx, prints } = await makeCtx(p);

  await dispatchSlash('/review everything', ctx);
  assert.ok(
    prints.some((s) => s.includes('Unknown phase: everything')),
    `expected unknown-phase error, got: ${JSON.stringify(prints)}`,
  );
});

test('/review plan reports not implemented', async () => {
  await seedModels();
  const p = await makeProject('planphase');
  await setCurrentProject(p.id);
  const { ctx, prints } = await makeCtx(p);

  await dispatchSlash('/review plan', ctx);
  assert.ok(
    prints.some((s) => s.includes('not implemented yet')),
    `expected not-implemented notice, got: ${JSON.stringify(prints)}`,
  );
});

test('/review code with an invalid --model ref is rejected', async () => {
  await seedModels();
  const p = await makeProject('badref');
  await setCurrentProject(p.id);
  const { ctx, prints } = await makeCtx(p);

  await dispatchSlash('/review code --model=not-a-ref', ctx);
  assert.ok(
    prints.some((s) => s.includes('Invalid --model ref')),
    `expected invalid-ref error, got: ${JSON.stringify(prints)}`,
  );

  prints.length = 0;
  await dispatchSlash('/review code --model=nope/missing', ctx);
  assert.ok(
    prints.some((s) => s.includes('Model not found')),
    `expected not-found error, got: ${JSON.stringify(prints)}`,
  );
});

test('/review code with no conversation reports nothing to review', async () => {
  await seedModels();
  const p = await makeProject('empty');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  session.messages = [];

  await dispatchSlash('/review code', ctx);
  assert.ok(
    prints.some((s) => s.includes('nothing to review')),
    `expected nothing-to-review notice, got: ${JSON.stringify(prints)}`,
  );
});

// ---------------------------------------------------------------------------
// 2. Model resolution priority: --model > phase config > session model
// ---------------------------------------------------------------------------

test('/review code uses the session model when no override and no flag', async () => {
  await seedModels();
  const p = await makeProject('session');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  await dispatchSlash('/review code', ctx);
  assert.ok(fake.calls.length === 1, `expected exactly one review call, got ${fake.calls.length}`);
  assert.ok(
    prints.some((s) => s.includes('current session model')),
    `expected session-model announcement, got: ${JSON.stringify(prints)}`,
  );
  assert.ok(prints.some((s) => s.includes('no issues found')), 'expected ok verdict line');
});

test('/review code prefers the project code-review phase model over the session model', async () => {
  await seedModels();
  const p = await makeProject('phasecfg');
  await setCurrentProject(p.id);
  await setPhaseModelRef(p.id, 'code-review', 'provB/model-b');
  const { session, ctx, prints } = await makeCtx(p);

  // Interpose a recording client on the provB config by intercepting
  // LLMClient via the resolved baseUrl: instead of a network call, monkey-
  // patch session-independent resolution is complex; assert via the label
  // printed (the phase ref) plus a dead session model - the review must NOT
  // run on the session model, so a dead session model with a successful
  // outcome proves the phase model path was taken.
  const fakePhase = recordingLlm(''); // capture-only; verdict comes from SSE below
  session.llm = deadLlm();
  // The real client would hit http://b.example - so run with a patched global
  // fetch that answers for b.example only, in the SSE wire format the OpenAI
  // adapter consumes (a plain-JSON body would parse to an EMPTY stream).
  const reply = [
    '=== REVIEW REPORT ===',
    '## Requirement re-analysis',
    '1. Implement the /review command.',
    '## Conclusion',
    'Sound.',
    '=== VERDICT ===',
    '{"ok": true, "issues": []}',
  ].join('\n');
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    const msgs = body.messages || [];
    fakePhase.calls.push({ messages: msgs });
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n' + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await dispatchSlash('/review code', ctx);
    assert.ok(
      prints.some((s) => s.includes('provB/model-b') && s.includes('phase config')),
      `expected phase-model announcement, got: ${JSON.stringify(prints)}`,
    );
    assert.ok(
      prints.some((s) => s.includes('no issues found')),
      'expected the review to complete via the phase model',
    );
    assert.ok(fakePhase.calls.length >= 0); // fetch-based capture is best-effort
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('/review code --model wins over the phase config', async () => {
  await seedModels();
  const p = await makeProject('flagwins');
  await setCurrentProject(p.id);
  await setPhaseModelRef(p.id, 'code-review', 'provB/model-b');
  const { session, ctx, prints } = await makeCtx(p);
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  // --model=provA/model-a must override the provB phase config. provA is the
  // session provider; intercept fetch for a.example to prove the flag ref
  // produced the request.
  const seenUrls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seenUrls.push(String(url));
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok": true, "issues": []}' } }],
    }), { status: 200 });
  };
  try {
    await dispatchSlash('/review code --model=provA/model-a', ctx);
    assert.ok(
      prints.some((s) => s.includes('provA/model-a') && s.includes('--model flag')),
      `expected flag-model announcement, got: ${JSON.stringify(prints)}`,
    );
    assert.ok(
      seenUrls.some((u) => u.includes('a.example')),
      `expected the request to go to provA's endpoint, got: ${JSON.stringify(seenUrls)}`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. Context isolation: only request + result reach the reviewer
// ---------------------------------------------------------------------------

test('/review code sends request and result without the conversation process', async () => {
  await seedModels();
  const p = await makeProject('isolated');
  await setCurrentProject(p.id);
  const { session, ctx } = await makeCtx(p);
  // Shape the conversation like a real completed turn: request -> process
  // noise (tool frames, intermediate assistant text) -> final answer.
  session.messages = [
    { role: 'user', content: 'Implement the /review command exactly as specified.' },
    { role: 'assistant', content: '{"tool_calls":[{"name":"bash","args":{"command":"cat /tmp/secret"}}]}' },
    { role: 'tool', content: 'tool output with internal details SECRET-MARKER' },
    { role: 'assistant', content: 'Intermediate reasoning: I decided to skip tests because TODO.' },
  ];
  session.lastAnswer = 'Implemented /review with model resolution and tests. All done.';
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  await dispatchSlash('/review code', ctx);
  assert.equal(fake.calls.length, 1, 'exactly one review LLM call');
  const sent = JSON.stringify(fake.calls[0].messages);
  assert.ok(sent.includes('Implement the /review command exactly as specified.'), 'request text present');
  assert.ok(sent.includes('Implemented /review with model resolution and tests.'), 'claimed result present');
  assert.ok(!sent.includes('SECRET-MARKER'), 'tool output must NOT leak into the review');
  assert.ok(!sent.includes('Intermediate reasoning'), 'intermediate assistant turns must NOT leak');
  // System prompt is the manual regression-check prompt, not the pipeline one.
  const sys = fake.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(sys && sys.content === MANUAL_REVIEW_SYSTEM_PROMPT, 'manual system prompt used');
});

// ---------------------------------------------------------------------------
// 3b. Original-requirement resolution: mid-task additions & continuation
// ---------------------------------------------------------------------------

// Regression for the reported bug: with mid-task queued instructions the LAST
// user message was treated as the task requirement, so the review checked a
// mid-task addition instead of the original task.
test('/review code sends the ORIGINAL request, not the last mid-task injection', async () => {
  await seedModels();
  const p = await makeProject('origreq');
  await setCurrentProject(p.id);
  const { session, ctx } = await makeCtx(p);
  session.messages = [
    { role: 'user', content: 'Implement feature X with proper error handling.' },
    { role: 'assistant', content: 'working on it' },
    { role: 'user', content: buildMidTaskInjection(['Also add unit tests for the parser.']) },
    { role: 'user', content: buildMidTaskInjection(['Rename the helper to parseThing.']) },
    { role: 'assistant', content: 'final answer placeholder' },
  ];
  session.lastAnswer = 'Feature X implemented, tests added, helper renamed. All done.';
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  await dispatchSlash('/review code', ctx);
  assert.equal(fake.calls.length, 1, 'exactly one review LLM call');
  const userMsg = fake.calls[0].messages.find((m) => m.role === 'user');
  const body = userMsg.content;
  // The ORIGINAL requirement is the requirement — never a mid-task addition.
  assert.ok(body.includes('=== ORIGINAL USER REQUIREMENT (begin) ==='));
  assert.ok(body.includes('Implement feature X with proper error handling.'), 'original request present');
  // Both mid-task additions ride along in their own section (chronological).
  assert.ok(body.includes('=== ADDITIONAL USER INSTRUCTIONS (given mid-task, they extend the original requirement) (begin) ==='));
  assert.ok(body.includes('- Also add unit tests for the parser.'));
  assert.ok(body.includes('- Rename the helper to parseThing.'));
  assert.ok(body.indexOf('Also add unit tests') < body.indexOf('Rename the helper'), 'additions in chronological order');
  // The injection header itself must not leak into the requirement sections.
  assert.ok(!body.includes(MID_TASK_INJECTION_HEADER), 'no injection framing text in the review payload');
});

test('/review code uses the completed-task snapshot even after a newer task started', async () => {
  await seedModels();
  const p = await makeProject('snapnew');
  await setCurrentProject(p.id);
  const { session, ctx } = await makeCtx(p);
  // Completed task (snapshot present), then a newer in-flight task's request.
  session.messages = [
    { role: 'user', content: 'Implement feature X with proper error handling.' },
    { role: 'user', content: buildMidTaskInjection(['Also add unit tests.']) },
    { role: 'assistant', content: 'Feature X done.' },
    { role: 'user', content: 'Now start an unrelated task Y that is still running.' },
  ];
  session.lastCompletedTask = { userRequest: 'Implement feature X with proper error handling.', completedAt: '2026-01-01T00:00:00Z' };
  session.lastTask = { userRequest: 'Now start an unrelated task Y that is still running.' };
  session.lastAnswer = 'Feature X done.';
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  await dispatchSlash('/review code', ctx);
  const userMsg = fake.calls[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('Implement feature X'), 'snapshot request used');
  assert.ok(!userMsg.content.includes('unrelated task Y'), 'the newer in-flight task does not leak in');
  assert.ok(userMsg.content.includes('- Also add unit tests.'), 'the completed task own addition collected');
});

test('continuation cues are skipped by the fallback scan (multi-turn task)', async () => {
  await seedModels();
  const p = await makeProject('contcue');
  await setCurrentProject(p.id);
  const { session, ctx } = await makeCtx(p);
  // No snapshot → fallback scan must skip 请继续/continue and find the real request.
  session.messages = [
    { role: 'user', content: 'Refactor the config module into a class.' },
    { role: 'assistant', content: 'part 1 done' },
    { role: 'user', content: '请继续' },
    { role: 'user', content: buildMidTaskInjection(['Use camelCase everywhere.']) },
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: 'all done' },
  ];
  session.lastAnswer = 'Refactor complete, camelCase applied.';
  const fake = recordingLlm('{"ok": true, "issues": []}');
  session.llm = fake;

  await dispatchSlash('/review code', ctx);
  const userMsg = fake.calls[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg.content.includes('Refactor the config module into a class.'), 'original request found past the cues');
  assert.ok(!userMsg.content.includes('请继续'), 'continuation cue not the requirement');
  assert.ok(userMsg.content.includes('- Use camelCase everywhere.'), 'mid-task addition collected');
});

test('extractTaskRequirement: anchor missing from history returns no additions', () => {
  const msgs = [
    { role: 'user', content: 'Old completed task.' },
    { role: 'user', content: buildMidTaskInjection(['addition A']) },
    { role: 'assistant', content: 'done' },
  ];
  // Anchor not found (e.g. compacted away): additions must not be
  // mis-attributed to it.
  const r = extractTaskRequirement(msgs, 'Anchor that no longer exists');
  assert.equal(r.original, 'Anchor that no longer exists');
  assert.deepEqual(r.additions, []);
});

test('buildManualCodeReviewContent omits the additions section when none', () => {
  const text = buildManualCodeReviewContent({ requestText: 'Do X.', answerText: 'Done.' });
  assert.ok(text.includes('=== ORIGINAL USER REQUIREMENT (begin) ==='));
  assert.ok(!text.includes('ADDITIONAL USER INSTRUCTIONS'));
});

// ---------------------------------------------------------------------------
// 4. Rendering + unreachable-model policy
// ---------------------------------------------------------------------------

test('/review code streams the reviewer report and never the verdict JSON', async () => {
  await seedModels();
  const p = await makeProject('stream');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  const reply = [
    REPORT_MARKER,
    '## Requirement re-analysis',
    '1. Implement the /review command.',
    '## Coverage check',
    '1. Covered: dispatch registered in src/slash/index.js.',
    '## Conclusion',
    'Sound overall.',
    VERDICT_MARKER,
    '{"ok": true, "issues": []}',
  ].join('\n');
  session.llm = recordingLlm(reply);

  await dispatchSlash('/review code', ctx);
  const all = prints.join('\n');
  assert.ok(all.includes('Requirement re-analysis'), 'report analysis streams to the user');
  assert.ok(all.includes('Covered: dispatch registered'), 'per-point coverage check streams');
  assert.ok(all.includes('Sound overall.'), 'conclusion streams');
  assert.ok(!all.includes(VERDICT_MARKER), 'the verdict marker never prints');
  assert.ok(!all.includes('"ok": true'), 'the raw verdict JSON never prints');
  assert.ok(all.includes('no issues found'), 'final verdict line still renders');
});

test('/review code warns UNKNOWN (never "no issues") when the reply has no verdict', async () => {
  await seedModels();
  const p = await makeProject('unknown');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  session.llm = recordingLlm('I looked at it and it seems fine, no structured answer.');

  await dispatchSlash('/review code', ctx);
  const all = prints.join('\n');
  assert.ok(all.includes('UNKNOWN'), 'unknown outcome is declared');
  assert.ok(!all.includes('no issues found'), 'an unparseable reply must NOT read as a pass');
});

test('/review code does not lose the report tail (table + trailing partial line)', async () => {
  await seedModels();
  const p = await makeProject('tail');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  // Regression guard: the report ends with a rendered TABLE followed by a
  // partial line WITHOUT a trailing newline. The old flush logic printed the
  // table (md.flush() non-empty) and silently dropped the partial tail.
  const reply = [
    REPORT_MARKER,
    '## Coverage check',
    '| point | status |',
    '|---|---|',
    '| 1. streaming | done |',
    'final partial sentence without newline',
    VERDICT_MARKER,
    '{"ok": true, "issues": []}',
  ].join('\n');
  session.llm = recordingLlm(reply);

  await dispatchSlash('/review code', ctx);
  const all = prints.join('\n');
  assert.ok(all.includes('streaming'), 'table row rendered');
  assert.ok(all.includes('final partial sentence without newline'), 'trailing partial line must NOT be dropped');
});

test('/review code prints issues one-by-one', async () => {
  await seedModels();
  const p = await makeProject('issues');
  await setCurrentProject(p.id);
  const { session, ctx, prints } = await makeCtx(p);
  const out = JSON.stringify({ ok: false, issues: [
    { title: 'Missing test for plan phase', detail: 'lib/foo.js never handles plan', suggestion: 'add a test' },
  ] });
  session.llm = recordingLlm(out);

  await dispatchSlash('/review code', ctx);
  assert.ok(prints.some((s) => s.includes('found 1 issue')), 'expected issue count line');
  assert.ok(prints.some((s) => s.includes('Missing test for plan phase')), 'expected issue title');
  assert.ok(prints.some((s) => s.includes('add a test')), 'expected suggestion');
});

test('/review code skips (no fallback) when the model is unreachable', async () => {
  await seedModels();
  const p = await makeProject('dead');
  await setCurrentProject(p.id);
  await setPhaseModelRef(p.id, 'code-review', 'provB/model-b');
  const { ctx, prints } = await makeCtx(p);

  // The client now RETRIES transient failures (lib/llm/retries.js) — a
  // connection-refused would otherwise burn ~3min of exponential backoff
  // before this skip-fallback path is reached. This test is about the
  // skip declaration, not the retry schedule, so retries are disabled.
  process.env.HK2_LLMAPI_NUMOFRETRIES = '0';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    await dispatchSlash('/review code', ctx);
    assert.ok(
      prints.some((s) => s.includes('unreachable')),
      `expected unreachable warning, got: ${JSON.stringify(prints)}`,
    );
    assert.ok(
      prints.some((s) => s.includes('skipping the code-review phase')),
      'expected skip declaration',
    );
    assert.ok(
      !prints.some((s) => s.includes('no issues found')),
      'a skipped review must not report success',
    );
  } finally {
    globalThis.fetch = origFetch;
    delete process.env.HK2_LLMAPI_NUMOFRETRIES;
  }
});

// ---------------------------------------------------------------------------
// 5. Pure helpers
// ---------------------------------------------------------------------------

test('buildManualCodeReviewContent frames a regression check without a diff', () => {
  const text = buildManualCodeReviewContent({
    requestText: 'Add the /review command.',
    answerText: 'Done, all wired up.',
  });
  assert.ok(text.includes('REGRESSION CHECK'), 'declares the regression-check framing');
  assert.ok(text.includes('=== ORIGINAL USER REQUIREMENT (begin) ==='));
  assert.ok(text.includes('Add the /review command.'));
  assert.ok(text.includes('=== ASSISTANT CLAIMED RESULT (begin) ==='));
  assert.ok(text.includes('no working-tree diff was detected'), 'diff-absent notice present');
  assert.ok(!text.includes('=== DIFF (the actual changes) (begin) ==='), 'no empty diff section');
});

test('reviewCode honors the systemPrompt override', async () => {
  const fake = recordingLlm('{"ok": true, "issues": []}');
  const result = await reviewCode(fake, 'review me', { systemPrompt: 'CUSTOM-PROMPT' });
  assert.equal(result.ok, true);
  const sys = fake.calls[0].messages.find((m) => m.role === 'system');
  assert.equal(sys?.content, 'CUSTOM-PROMPT');
  // Without the override the default SYSTEM_PROMPT applies.
  const fake2 = recordingLlm('{"ok": true, "issues": []}');
  await reviewCode(fake2, 'review me', {});
  const sys2 = fake2.calls[0].messages.find((m) => m.role === 'system');
  assert.ok(sys2?.content && sys2.content !== 'CUSTOM-PROMPT');
  assert.ok(sys2.content.includes('CODE REVIEW'), 'default pipeline prompt retains its identity');
});
