/*-------------------------------------------------------------------------
 *
 * Unit tests for interruption-recovery:
 *   - isContinuationCue recognizes English AND Chinese continuation cues
 *     (the original bug: 中文 "请继续" was misclassified as a new task and
 *     wiped the live planProgress)
 *   - task_state save/load/clear round-trips so a process restart can
 *     resume an interrupted task
 *
 * Run:  node --test test/interruption-recovery.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { isContinuationCue } from '../src/commands/interactive.js';
import { buildResumeContext, buildSessionDigest, advancePlanStep } from '../src/commands/interactive.js';
import { saveTaskState, loadTaskState, clearTaskState } from '../lib/agent/task_state.js';
import { buildTools, executeToolCall } from '../lib/agent/tools.js';

/* ----- isContinuationCue ----- */

test('isContinuationCue: English cues are recognized', () => {
  assert.equal(isContinuationCue('continue'), true);
  assert.equal(isContinuationCue('Continue'), true);
  assert.equal(isContinuationCue('please continue'), true);
  assert.equal(isContinuationCue('go ahead'), true);
  assert.equal(isContinuationCue('go on'), true);
  assert.equal(isContinuationCue('ok'), true);
  assert.equal(isContinuationCue('yes'), true);
  assert.equal(isContinuationCue('keep going'), true);
  assert.equal(isContinuationCue('proceed'), true);
  assert.equal(isContinuationCue('next'), true);
  assert.equal(isContinuationCue('done'), true);
});

test('isContinuationCue: Chinese cues are recognized (the original bug)', () => {
  // These MUST be continuation cues, otherwise handleLine wipes planProgress.
  assert.equal(isContinuationCue('请继续'), true);
  assert.equal(isContinuationCue('继续'), true);
  assert.equal(isContinuationCue('接着做'), true);
  assert.equal(isContinuationCue('继续做'), true);
  assert.equal(isContinuationCue('继续吧'), true);
  assert.equal(isContinuationCue('往下做'), true);
  assert.equal(isContinuationCue('接着'), true);
});

test('isContinuationCue: Chinese cue with trailing punctuation still matches', () => {
  // Users often type "请继续。" or "继续，把剩下的做完"
  assert.equal(isContinuationCue('请继续。'), true);
  assert.equal(isContinuationCue('继续，把剩下的做完'), true);
});

test('isContinuationCue: fresh tasks are NOT continuation cues', () => {
  assert.equal(isContinuationCue('refactor the auth module'), false);
  assert.equal(isContinuationCue('add a new endpoint for /users'), false);
  assert.equal(isContinuationCue('帮我看一下这个文件'), false);
  assert.equal(isContinuationCue('请重构 plan-progress 模块'), false);
  assert.equal(isContinuationCue(''), false);
  assert.equal(isContinuationCue(null), false);
  assert.equal(isContinuationCue(undefined), false);
});

test('isContinuationCue: "continue with X" is a continuation (word boundary)', () => {
  // The cue may be followed by more words; \b anchors the first token.
  assert.equal(isContinuationCue('continue with step 2'), true);
  assert.equal(isContinuationCue('go ahead and finish'), true);
});

/* ----- task_state round-trip ----- */
// task_state uses projectTaskStatePath = SESSIONS_ROOT/<projectId>/taskstate.json.
// To test it in isolation without touching the real ~/.hk2, we point HK2_HOME
// at a temp dir for this process.

let tmpHome = '';
let origHome = '';

test.before(async () => {
  origHome = process.env.HK2_HOME || '';
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-taskstate-'));
  process.env.HK2_HOME = tmpHome;
});

test.after(async () => {
  if (origHome) process.env.HK2_HOME = origHome;
  else delete process.env.HK2_HOME;
  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

test('task_state: load returns null when nothing persisted', async () => {
  const state = await loadTaskState('proj-no-such');
  assert.equal(state, null);
});

test('task_state: save then load round-trips the task context + planProgress', async () => {
  const projectId = 'proj-rt';
  const planProgress = {
    summary: 'do the thing',
    steps: [
      { goal: 'step A', strategy: 'alpha', status: 'done' },
      { goal: 'step B', strategy: 'beta', status: 'in_progress' },
      { goal: 'step C', strategy: 'gamma', status: 'pending' },
    ],
    current: 1,
  };
  await saveTaskState(projectId, {
    userRequest: 'refactor the plan-progress module',
    taskSummary: 'Step 1 done\n> Step 2 in_progress',
    planProgress,
    sessionId: 'sess-1',
    reason: 'error',
  });

  const loaded = await loadTaskState(projectId);
  assert.ok(loaded, 'state should load after save');
  assert.equal(loaded.userRequest, 'refactor the plan-progress module');
  assert.equal(loaded.reason, 'error');
  assert.equal(loaded.sessionId, 'sess-1');
  assert.ok(loaded.interruptedAt, 'interruptedAt should be stamped on save');
  assert.deepEqual(loaded.planProgress, planProgress);
});

test('task_state: clear removes the persisted state', async () => {
  const projectId = 'proj-clear';
  await saveTaskState(projectId, { userRequest: 'temp task', planProgress: null });
  assert.ok(await loadTaskState(projectId), 'state exists before clear');
  await clearTaskState(projectId);
  assert.equal(await loadTaskState(projectId), null, 'state gone after clear');
});

test('task_state: clear is a no-op when nothing was persisted', async () => {
  // Should not throw.
  await clearTaskState('proj-never-saved');
});

test('task_state: save with null projectId is a safe no-op', async () => {
  await saveTaskState(null, { userRequest: 'x' });
  assert.equal(await loadTaskState(null), null);
  await clearTaskState(null);
});

test('task_state: overwriting a previous state reflects the latest task', async () => {
  const projectId = 'proj-overwrite';
  await saveTaskState(projectId, { userRequest: 'old task', planProgress: null });
  await saveTaskState(projectId, { userRequest: 'new task', planProgress: null });
  const loaded = await loadTaskState(projectId);
  assert.equal(loaded.userRequest, 'new task');
  await clearTaskState(projectId);
});

/* ----- buildResumeContext: interruption-recovery injection ----- */
// Mirrors the confirmPlan planProgress assignment used in interactive.js.
function makePlanProgress() {
  return {
    summary: 'do the thing',
    steps: [
      { goal: 'step A', strategy: 'alpha - d1', status: 'done' },
      { goal: 'step B', strategy: 'beta - d2', status: 'in_progress' },
      { goal: 'step C', strategy: 'gamma - d3', status: 'pending' },
    ],
    current: 1,
  };
}

test('buildResumeContext: returns null when there is no lastTask', () => {
  const session = { planProgress: null, lastTask: null };
  assert.equal(buildResumeContext(session), null);
});

test('buildResumeContext: includes the original user request and in_progress step', () => {
  const session = {
    lastTask: { userRequest: 'refactor the plan-progress module' },
    planProgress: makePlanProgress(),
  };
  const msg = buildResumeContext(session);
  assert.ok(msg, 'should produce a resume message');
  assert.match(msg, /refactor the plan-progress module/);
  assert.match(msg, /Resuming an interrupted task/);
  assert.match(msg, /step A/);
  assert.match(msg, /step B/);
  assert.match(msg, /step C/);
  // The in_progress step should be visible so the model knows what to finish.
  assert.match(msg, /in_progress|in progress|>.*step B/i);
});

test('buildResumeContext: when no plan was active, still recovers the request', () => {
  // This is the case where the interruption happened before the plan tool
  // fired (or the plan tool_use was stripped by stripDanglingToolUse). The
  // model still needs to know WHAT it was asked to do.
  const session = {
    lastTask: { userRequest: 'add a /status slash command' },
    planProgress: null,
  };
  const msg = buildResumeContext(session);
  assert.ok(msg);
  assert.match(msg, /add a \/status slash command/);
  assert.match(msg, /No structured plan was active/i);
});

/* ----- buildSessionDigest: session task context for request assessment ----- */
// The clarity assessor gets this digest so follow-ups that are ambiguous in
// isolation ("continue", "fix it") are judged against what the session is
// already working on.

test('buildSessionDigest: returns empty string when the session has no task context', () => {
  const session = { planProgress: null, lastTask: null, messages: [] };
  assert.equal(buildSessionDigest(session, 'do a new thing'), '');
});

test('buildSessionDigest: includes the in-flight task when it differs from the current request', () => {
  const session = {
    lastTask: { userRequest: 'refactor the plan-progress module' },
    planProgress: null,
    messages: [],
  };
  const digest = buildSessionDigest(session, 'fix it');
  assert.match(digest, /In-flight task/);
  assert.match(digest, /refactor the plan-progress module/);
});

test('buildSessionDigest: omits the in-flight task when it equals the current request (fresh turn)', () => {
  // On a fresh (non-continuation) turn, lastTask.userRequest === userText;
  // repeating it would add noise, not signal.
  const session = {
    lastTask: { userRequest: 'start a brand new task' },
    planProgress: null,
    messages: [],
  };
  const digest = buildSessionDigest(session, 'start a brand new task');
  assert.equal(digest.indexOf('In-flight task'), -1);
});

test('buildSessionDigest: renders plan progress as plain text with statuses', () => {
  const session = {
    lastTask: { userRequest: 'do the thing' },
    planProgress: makePlanProgress(),
    messages: [],
  };
  const digest = buildSessionDigest(session, 'fix it');
  assert.match(digest, /Active plan progress:/);
  assert.match(digest, /\[done\] step A/);
  assert.match(digest, /\[in progress\] step B/);
  assert.match(digest, /\[pending\] step C/);
});

test('buildSessionDigest: includes the last few user/assistant turns and skips system messages', () => {
  const session = {
    lastTask: { userRequest: 'fix the parser' },
    planProgress: null,
    messages: [
      { role: 'system', content: '## Resuming an interrupted task\nblah' },
      { role: 'user', content: 'fix the parser' },
      { role: 'assistant', content: 'I fixed lib/parser.js, see commit abc123.' },
      { role: 'user', content: 'same for the lexer' },
      // structured (tool-call) assistant content must be skipped, not crash
      { role: 'assistant', content: [{ type: 'text', text: 'structured' }] },
      { role: 'assistant', content: 'done with the lexer too' },
    ],
  };
  const digest = buildSessionDigest(session, 'continue');
  assert.match(digest, /Recent conversation/);
  assert.match(digest, /User: fix the parser/);
  assert.match(digest, /Assistant: I fixed lib\/parser\.js/);
  assert.match(digest, /User: same for the lexer/);
  assert.doesNotMatch(digest, /Resuming an interrupted task/);
});

test('buildSessionDigest: caps turn length so a huge answer cannot blow up the digest', () => {
  const long = 'x'.repeat(5000);
  const session = {
    lastTask: null,
    planProgress: null,
    messages: [{ role: 'user', content: long }],
  };
  const digest = buildSessionDigest(session, 'continue');
  const line = digest.split('\n').find(l => l.includes('User:')) || '';
  // Recent turns get an adaptive 480-char budget (P0-2) — the cap still
  // bounds a huge turn, it just keeps head+tail instead of head-only.
  assert.ok(line.length <= 500, `turn line should be capped, got ${line.length}`);
  assert.ok(line.includes('…'), 'long line is truncated with an ellipsis');
});

test('buildSessionDigest: long turn keeps the TAIL (decision-critical closing survives)', () => {
  // The assistant's "输入下一步即可开始" invitation lives at the END of a
  // long message; the old head-only truncation cut it off entirely.
  const long = '背景分析。'.repeat(200) + '综上所述，计划已制定，输入下一步即可开始。';
  const session = {
    lastTask: null,
    planProgress: null,
    messages: [{ role: 'assistant', content: long }],
  };
  const digest = buildSessionDigest(session, '执行下一步');
  assert.ok(digest.includes('输入下一步即可开始'), 'the closing invitation survives truncation');
});

test('buildSessionDigest: renders the assistant\'s latest closing tail as its own section', () => {
  const session = {
    lastTask: null,
    planProgress: null,
    messages: [
      { role: 'user', content: '分析一下' },
      { role: 'assistant', content: '开头是很长的分析。'.repeat(80) + '\n\n计划已制定：\n1. 步骤一\n2. 步骤二\n\n输入下一步即可开始。' },
    ],
  };
  const digest = buildSessionDigest(session, '执行下一步');
  assert.match(digest, /The assistant's most recent message ended with:/);
  assert.ok(digest.includes('输入下一步即可开始'), 'the closing tail section carries the invitation');
  assert.ok(digest.includes('步骤一'), 'the tail section keeps the plan options');
});

test('buildSessionDigest: continuation flag is rendered when passed', () => {
  const session = {
    lastTask: { userRequest: 'do the thing' },
    planProgress: null,
    messages: [],
  };
  const digest = buildSessionDigest(session, '继续', { continuation: true });
  assert.match(digest, /matched a continuation cue/);
  // Without the flag the line is absent.
  const digest2 = buildSessionDigest(session, '继续');
  assert.equal(digest2.includes('matched a continuation cue'), false);
});

/* ----- plan_step still advances a RESTORED planProgress ----- */
// After a cross-process restore, planProgress is reconstituted from disk.
// The plan_step tool / planStep callback must still be able to advance it so
// the progress panel keeps moving on a "请继续" resume.
test('plan_step advances a restored (reconstituted) planProgress', async () => {
  const restoredProgress = makePlanProgress(); // step A done, B in_progress, C pending
  const session = { planProgress: restoredProgress };
  let marked = null;
  const tools = buildTools(null, {
    allowWrite: false,
    planStep: async (step, note) => {
      marked = { step, note };
      // REAL state machine (status_format.advancePlanStep) — no local mirror;
      // mirrors drifted from the production logic in past regressions.
      return advancePlanStep(session, step, note);
    },
  });
  // First plan_step: finishes step B (the in_progress one), advances to C.
  await executeToolCall(tools, { name: 'plan_step', arguments: { step: 2 } });
  assert.equal(marked.step, 2);
  assert.equal(session.planProgress.steps[1].status, 'done');
  assert.equal(session.planProgress.steps[2].status, 'in_progress');
  assert.equal(session.planProgress.current, 2);
  // Second plan_step: finishes step C, plan clears (all done).
  await executeToolCall(tools, { name: 'plan_step', arguments: { step: 3 } });
  assert.equal(session.planProgress, null, 'plan clears when all steps done');
});

test('full resume round-trip: save -> load -> buildResumeContext yields the right context', async () => {
  const projectId = 'proj-resume-rt';
  const planProgress = makePlanProgress();
  // Simulate an interruption: persist the in-flight task state.
  await saveTaskState(projectId, {
    userRequest: 'fix the plan-progress bug',
    taskSummary: 'step A done\n> step B in_progress',
    planProgress,
    sessionId: 'sess-rt',
    reason: 'interrupted',
  });
  // Simulate a fresh process restoring it.
  const loaded = await loadTaskState(projectId);
  assert.ok(loaded);
  const restoredSession = {
    lastTask: { userRequest: loaded.userRequest },
    planProgress: loaded.planProgress,
  };
  const msg = buildResumeContext(restoredSession);
  assert.ok(msg);
  assert.match(msg, /fix the plan-progress bug/);
  assert.match(msg, /step B/);
  await clearTaskState(projectId);
});
