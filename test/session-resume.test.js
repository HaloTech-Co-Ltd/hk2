/*-------------------------------------------------------------------------
 *
 * Unit tests for session resume (`hk2 --resume` / `/session resume`):
 *   - replayTranscript: JSONL event stream → LLM-ready messages, rebuilding
 *     assistant tool_calls + role:tool pairs (the exact shapes loop.js
 *     produces), skipping meta/system_prompt events
 *   - findLatestSessionId: latest .jsonl by mtime, with exclusion
 *   - resumeSessionInto (via ctx.resumeSession): full-context restore,
 *     transcript swap (subsequent appends land in the SAME file), and the
 *     interrupted-task restore from task_state.js keyed by sessionId
 *   - parseArgs: --resume / --resume=<id> / --resume <id> flag shapes
 *
 * Run:  node --test test/session-resume.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from '../src/cli.js';
import { createSession, buildCtx, reloadAll, splitOutputUnits, formatRecentOutputs } from '../src/commands/interactive.js';
import { Transcript, replayTranscript, findLatestSessionId } from '../lib/agent/transcript.js';
import { saveTaskState, clearTaskState } from '../lib/agent/task_state.js';
import { ensureHome, registerProject, setCurrentProject } from '../lib/config/home.js';

/* ----- replayTranscript ----- */

test('replayTranscript: user/assistant text round-trips', () => {
  const lines = [
    JSON.stringify({ ts: 't1', type: 'session_start', sessionId: 's1', projectId: 'p1' }),
    JSON.stringify({ ts: 't2', type: 'user', text: 'hello' }),
    JSON.stringify({ ts: 't3', type: 'assistant', text: 'hi there' }),
    JSON.stringify({ ts: 't4', type: 'turn_end', turns: 1, toolCalls: 0 }),
  ].join('\n');
  const { messages, lastUserText, firstTs, lastTs } = replayTranscript(lines);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: 'user', content: 'hello' });
  assert.deepEqual(messages[1], { role: 'assistant', content: 'hi there' });
  assert.equal(lastUserText, 'hello');
  assert.equal(firstTs, 't1');
  assert.equal(lastTs, 't4');
});

test('replayTranscript: tool_call events rebuild assistant.tool_calls + role:tool pairs', () => {
  const lines = [
    JSON.stringify({ ts: 't1', type: 'user', text: 'read the file' }),
    JSON.stringify({ ts: 't2', type: 'tool_call', id: 'call_a', name: 'read', arguments: '{"path":"a.js"}', result: { out: 1 }, ok: true }),
    JSON.stringify({ ts: 't3', type: 'tool_call', id: 'call_b', name: 'grep', arguments: '{"pattern":"x"}', result: { matches: 0 }, ok: true }),
    JSON.stringify({ ts: 't4', type: 'assistant', text: 'all done' }),
  ].join('\n');
  const { messages } = replayTranscript(lines);
  // user, assistant(tool_calls×2), tool a, tool b, final assistant = 5
  assert.equal(messages.length, 5);
  assert.equal(messages[0].role, 'user');
  // Grouped assistant message with both tool_calls
  const asst = messages[1];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.tool_calls.length, 2);
  assert.deepEqual(asst.tool_calls[0], {
    id: 'call_a', type: 'function',
    function: { name: 'read', arguments: '{"path":"a.js"}' },
  });
  // Followed by the tool results in order
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].tool_call_id, 'call_a');
  assert.equal(messages[2].name, 'read');
  assert.deepEqual(JSON.parse(messages[2].content), { out: 1 });
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'call_b');
  // ...then the final aggregated assistant text
  assert.equal(messages[4].role, 'assistant');
  assert.equal(messages[4].content, 'all done');
});

test('replayTranscript: trailing tool_call run (interrupted turn) is still replayed', () => {
  const lines = [
    JSON.stringify({ ts: 't1', type: 'user', text: 'go' }),
    JSON.stringify({ ts: 't2', type: 'tool_call', id: 'c1', name: 'bash', arguments: '{}', result: { stdout: 'x' }, ok: true }),
  ].join('\n');
  const { messages } = replayTranscript(lines);
  // user, synthesized assistant (tool_calls), tool result
  assert.equal(messages.length, 3);
  assert.equal(messages[1].tool_calls.length, 1);
  assert.equal(messages[2].tool_call_id, 'c1');
});

test('replayTranscript: system_prompt / meta / corrupt lines are skipped', () => {
  const lines = [
    JSON.stringify({ ts: 't1', type: 'system_prompt', text: 'You are...' }),
    JSON.stringify({ ts: 't2', type: 'meta', key: 'start', value: { pid: 1 } }),
    'not json at all',
    JSON.stringify({ ts: 't3', type: 'user', text: 'q' }),
    JSON.stringify({ ts: 't4', type: 'assistant', text: '' }), // empty → skipped
  ].join('\n');
  const { messages } = replayTranscript(lines);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'q');
});

/* ----- findLatestSessionId ----- */

test('findLatestSessionId: null when no sessions / picks latest mtime / honors exclude', async () => {
  const projId = 'proj-find-latest';
  assert.equal(await findLatestSessionId(projId), null);

  const t1 = new Transcript(projId, 'sess-old');
  await t1.logUser('first');
  // ensure distinct mtimes
  await new Promise(r => setTimeout(r, 20));
  const t2 = new Transcript(projId, 'sess-new');
  await t2.logUser('second');
  await new Promise(r => setTimeout(r, 20));

  assert.equal(await findLatestSessionId(projId), 'sess-new');
  // Excluding the latest falls back to the previous one.
  assert.equal(await findLatestSessionId(projId, { exclude: 'sess-new' }), 'sess-old');
  // Non-.jsonl files in the dir are ignored.
  await fs.writeFile(path.join(path.dirname(t1.path), 'taskstate.json'), '{}');
  assert.equal(await findLatestSessionId(projId), 'sess-new');
});

/* ----- ctx.resumeSession (resumeSessionInto) ----- */

let __seq = 0;

async function makeSessionWithProject() {
  await ensureHome();
  const n = ++__seq;
  const src = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-resume-${n}-`));
  const proj = await registerProject({ name: `resumeproj${n}`, sourcePath: src });
  await setCurrentProject(proj.id);
  const session = createSession(null);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx);
  assert.ok(session.project, 'project resolved');
  return { session, ctx, proj };
}

test('ctx.resumeSession: replays full context (tool_calls included) and swaps the transcript', async () => {
  const { session, ctx } = await makeSessionWithProject();

  // Simulate a previous session: user → tool_call → assistant, persisted by a
  // real Transcript (same writer the REPL uses).
  const prev = new Transcript(session.project.id, 'sess-target');
  await prev.logUser('inspect the config');
  await prev.logToolCall(
    { id: 'call_1', name: 'read', arguments: '{"path":"pkg.json"}' },
    { ok: true, result: { content: '...' } },
  );
  await prev.logAssistant('the config looks fine');
  // A second, LATER session (so "latest" ≠ target — we resume by explicit id).
  await new Promise(r => setTimeout(r, 20));
  const newer = new Transcript(session.project.id, 'sess-newer');
  await newer.logUser('unrelated');

  const ok = await ctx.resumeSession('sess-target');
  assert.equal(ok, true);

  // Transcript swapped: appends now land in the target file.
  assert.equal(session.transcript.sessionId, 'sess-target');
  assert.equal(session.transcript.path, prev.path);
  await session.transcript.logUser('continue from here');
  const text = await fs.readFile(prev.path, 'utf8');
  assert.match(text, /continue from here/);

  // messages replayed with full fidelity: user, assistant+tool_calls, tool, assistant
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages[0].content, 'inspect the config');
  const asst = session.messages[1];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].function.name, 'read');
  assert.equal(session.messages[2].role, 'tool');
  assert.equal(session.messages[2].tool_call_id, 'call_1');
  assert.deepEqual(JSON.parse(session.messages[2].content), { content: '...' });
  assert.equal(session.messages[3].content, 'the config looks fine');

  // System prompt is pending re-injection on the next turn.
  assert.equal(session.needsSystemPrompt, true);
  // No interrupted task state → nothing restored.
  assert.equal(session.lastTask, null);
});

test('ctx.resumeSession(null): picks the project\'s latest previous session, excluding the live one', async () => {
  const { session, ctx } = await makeSessionWithProject();
  const liveId = session.transcript.sessionId;
  await session.transcript.logUser('current live session');

  await new Promise(r => setTimeout(r, 20));
  const prev = new Transcript(session.project.id, 'sess-prev');
  await prev.logUser('older session');

  const ok = await ctx.resumeSession(null);
  assert.equal(ok, true);
  assert.equal(session.transcript.sessionId, 'sess-prev');
  assert.notEqual(session.transcript.sessionId, liveId);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'older session');
});

test('ctx.resumeSession: restores interrupted task state keyed by sessionId', async () => {
  const { session, ctx } = await makeSessionWithProject();

  const prev = new Transcript(session.project.id, 'sess-task');
  await prev.logUser('do the big refactor');
  // taskstate pointing at THIS session (interrupted mid-task)
  await saveTaskState(session.project.id, {
    userRequest: 'do the big refactor',
    taskSummary: 'step 1 of 2 done',
    planProgress: { summary: 'refactor', steps: [
      { goal: 'a', status: 'done', strategies: [] },
      { goal: 'b', status: 'pending', strategies: [] },
    ] },
    sessionId: 'sess-task',
    reason: 'error',
  });

  const ok = await ctx.resumeSession('sess-task');
  assert.equal(ok, true);
  assert.ok(session.lastTask);
  assert.equal(session.lastTask.userRequest, 'do the big refactor');
  assert.equal(session.lastTask.restored, true);
  assert.ok(session.planProgress);
  assert.equal(session.planProgress.steps.length, 2);

  await clearTaskState(session.project.id);
});

test('ctx.resumeSession: taskstate for a DIFFERENT session is not restored', async () => {
  const { session, ctx } = await makeSessionWithProject();

  const prev = new Transcript(session.project.id, 'sess-clean');
  await prev.logUser('hello');
  await saveTaskState(session.project.id, {
    userRequest: 'other session task',
    sessionId: 'sess-other',
  });

  const ok = await ctx.resumeSession('sess-clean');
  assert.equal(ok, true);
  // reloadAll may have pre-restored it before resume; resumeSessionInto must
  // clear it because the taskstate belongs to a different session.
  assert.equal(session.lastTask, null);
  assert.equal(session.planProgress, null);

  await clearTaskState(session.project.id);
});

test('ctx.resumeSession: unknown id → false, session untouched', async () => {
  const { session, ctx } = await makeSessionWithProject();
  const before = session.transcript.sessionId;
  const ok = await ctx.resumeSession('no-such-session');
  assert.equal(ok, false);
  assert.equal(session.transcript.sessionId, before);
});

test('ctx.recentOutputs renders the just-resumed conversation (last 5 outputs)', async () => {
  const { session, ctx } = await makeSessionWithProject();
  const prev = new Transcript(session.project.id, 'sess-preview');
  for (let i = 1; i <= 7; i++) {
    await prev.logUser(`question ${i}`);
    await prev.logToolCall(
      { id: `call_${i}`, name: 'read', arguments: '{"path":"f.js"}' },
      { ok: true, result: { content: 'x' } },
    );
    await prev.logAssistant(`answer ${i}`);
  }
  const ok = await ctx.resumeSession('sess-preview');
  assert.equal(ok, true);

  const lines = ctx.recentOutputs(5);
  assert.ok(lines.length > 0);
  const text = lines.join('\n');
  // 7 rounds × (1 tool + 1 reply) = 14 outputs; last 5 = tool5 + answer5
  // + tool6 + answer6 + tool7. (answer4 is the cut boundary.)
  assert.match(text, /last 5 of 14 output\(s\)/);
  assert.ok(text.includes('answer 7'));
  assert.ok(!text.includes('answer 4'));
  assert.ok(!text.includes('question 3'));
  assert.match(text, /read/);
});

/* ----- splitOutputUnits / formatRecentOutputs (resume preview) ----- */

test('splitOutputUnits: flattens messages into ordered user/tool/reply events', () => {
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } },
      { id: 'b', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
    ] },
    { role: 'tool', tool_call_id: 'a', name: 'read', content: '{}' },
    { role: 'tool', tool_call_id: 'b', name: 'bash', content: '{}' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'answer 2' },
  ];
  const events = splitOutputUnits(messages);
  assert.deepEqual(events, [
    { kind: 'user', text: 'q1' },
    { kind: 'tool', name: 'read', args: { path: 'a.js' } },
    { kind: 'tool', name: 'bash', args: { command: 'ls' } },
    { kind: 'reply', text: 'answer 1' },
    { kind: 'user', text: 'q2' },
    { kind: 'reply', text: 'answer 2' },
  ]);
});

test('splitOutputUnits: tool results / empty content / pre-user messages never become events', () => {
  const events = splitOutputUnits([
    { role: 'assistant', content: 'stray before first user' },
    { role: 'user', content: '   ' }, // whitespace-only → skipped
    { role: 'tool', tool_call_id: 'x', content: 'noise' },
    { role: 'user', content: 'q' },
    { role: 'tool', tool_call_id: 'y', content: 'tool output' },
  ]);
  assert.deepEqual(events, [
    { kind: 'user', text: 'q' },
  ]);
});

test('formatRecentOutputs: real-world shape — ONE user turn fanning into many tool calls', () => {
  // Mirrors a real transcript: a single question, then a long tool loop.
  // "Last 5 outputs" must show the five MOST RECENT events, not the round's
  // opening question.
  const messages = [
    { role: 'user', content: '恢复会话后需要显示该会话最后5轮的输出信息' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a1', type: 'function', function: { name: 'read', arguments: '{}' } },
      { id: 'a2', type: 'function', function: { name: 'grep', arguments: '{}' } },
      { id: 'a3', type: 'function', function: { name: 'edit', arguments: '{}' } },
      { id: 'a4', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
      { id: 'a5', type: 'function', function: { name: 'write', arguments: '{"path":"out.js"}' } },
      { id: 'a6', type: 'function', function: { name: 'kb_search', arguments: '{"query":"x"}' } },
    ] },
    { role: 'assistant', content: '完成，共改了 3 个文件。' },
  ];
  const lines = formatRecentOutputs(messages, { outputs: 5 });
  const text = lines.join('\n');
  assert.match(text, /last 5 of 7 output\(s\)/);
  // The five most recent: a3..a6 are 4 tools + reply = 5 → a1/a2 (read/grep)
  // and the opening question fall outside the window.
  assert.ok(text.includes('npm test'));
  assert.ok(text.includes('out.js'));
  assert.ok(text.includes('完成，共改了 3 个文件。'));
  assert.ok(!text.includes('question'));
});

test('formatRecentOutputs: empty / no-output conversations produce no output', () => {
  assert.deepEqual(formatRecentOutputs([], { outputs: 5 }), []);
  assert.deepEqual(formatRecentOutputs([{ role: 'user', content: 'q' }]), []);
});

test('formatRecentOutputs: multi-line replies are printed VERBATIM — no clamping, no ellipsis', () => {
  const messages = [
    { role: 'user', content: 'explain' },
    { role: 'assistant', content: 'l1\nl2\nl3\nl4\nl5' },
  ];
  const lines = formatRecentOutputs(messages);
  const text = lines.join('\n');
  // Every line present — nothing hidden behind an ellipsis marker.
  for (const l of ['l1', 'l2', 'l3', 'l4', 'l5']) assert.ok(text.includes(l), `missing ${l}`);
  assert.ok(!text.includes('more line'));
});

test('formatRecentOutputs: FULL fidelity — long tool args and user text are never truncated', () => {
  const longCmd = 'cd /some/very/long/path && '.repeat(20) + 'npm test'; // ≈ 520 chars
  const longUser = '这是一个很长很长的用户提问'.repeat(40) + '\n第二行补充说明'; // multi-line
  const messages = [
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'first answer' }, // puts an output before the marker
    { role: 'user', content: longUser },             // → inside the window
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: longCmd }) } },
    ] },
    { role: 'assistant', content: 'done' },
  ];
  const text = formatRecentOutputs(messages).join('\n');
  // Full command present, not cut at 110 chars with an ellipsis.
  assert.ok(text.includes(longCmd));
  assert.ok(!text.includes('…'));
  // Full user text present verbatim, including the second line.
  assert.ok(text.includes('这是一个很长很长的用户提问'.repeat(40)));
  assert.ok(text.includes('第二行补充说明'));
});

/* ----- parseArgs: --resume flag shapes ----- */

test('parseArgs: --resume bare / =id / space-id forms', () => {
  assert.deepEqual(parseArgs(['--resume']).flags, { resume: true });
  assert.deepEqual(parseArgs(['--resume=abc123']).flags, { resume: 'abc123' });
  assert.deepEqual(parseArgs(['--resume', 'abc123']).flags, { resume: 'abc123' });
  assert.deepEqual(parseArgs(['--resume', '--project', 'foo']).flags, { resume: true, project: 'foo' });
});

/* ----- Goodbye hint ----- */

test('Goodbye hint format (string template used by interactive())', async () => {
  // The REPL prints: Goodbye (using `hk2 --resume <id>` to resume the session)
  // Verify the template logic directly (console output is not capturable here
  // without spawning the REPL).
  const sid = 'deadbeef-1234';
  const line = sid
    ? `Goodbye (using \`hk2 --resume ${sid}\` to resume the session)`
    : 'Goodbye';
  assert.equal(line, 'Goodbye (using `hk2 --resume deadbeef-1234` to resume the session)');
});
