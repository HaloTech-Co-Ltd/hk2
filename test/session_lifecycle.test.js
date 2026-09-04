/* Session replacement must not leak conversation/task/review state. */
import './_learn_setup.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSession,
  buildCtx,
  reloadAll,
} from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';
import { ensureHome, registerProject, setCurrentProject } from '../lib/config/home.js';
import { Transcript } from '../lib/agent/transcript.js';
import { clearTaskState, saveTaskState } from '../lib/agent/task_state.js';

let seq = 0;

async function makeSession() {
  await ensureHome();
  const sourcePath = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-session-lifecycle-' + (++seq) + '-'));
  const project = await registerProject({ name: 'session-lifecycle-' + seq, sourcePath });
  await setCurrentProject(project.id);
  const session = createSession(project.id);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx);
  return { project, session, ctx };
}

function dirtyConversation(session) {
  session.messages = [{ role: 'user', content: 'old request' }];
  session.lastAnswer = 'old answer';
  session.lastTask = { userRequest: 'old request' };
  session.lastCompletedTask = { userRequest: 'completed old request' };
  session.planProgress = { summary: 'old plan', steps: [{ goal: 'old', status: 'pending' }] };
  session.hadPlanThisTurn = true;
  session.lastPlanText = 'old plan text';
  session.lastContextTokens = 99;
  session.kbLearnHandledAt = 123;
  session.kbConflicts = [{ old: true }];
  session.kbSavedThisTurn = true;
  session.kbSavedEntries = ['old'];
  session.bashSearchCommands = ['grep old'];
  session.loopKbCalls = ['old'];
  session.loopFallbackCalls = ['old'];
  session.loopKbPrefetch = { old: true };
  session.loopCallSeq = 7;
  session.tokens.callIn = 11;
  session.tokens.cumOut = 22;
  session.sessionFacts = ['old fact'];
  session.phase = 'working';
  session.turnStart = 123;
  session.userInputQueue = ['old queued task'];
  session.queue = ['queued slash command'];
}

test('/session new resets task, review, plan, facts, counters and starts a new transcript', async () => {
  const { session, ctx } = await makeSession();
  const oldId = session.transcript.sessionId;
  const oldProject = session.project;
  const oldPinnedProjectId = session.pinnedProjectId;
  const oldRuntime = session.rt;
  const oldModelCfg = session.modelCfg;
  session.sessionModelRef = 'example/provider-model';
  const oldStartedAt = session.startedAt;
  dirtyConversation(session);

  const prints = [];
  ctx.print = (text) => prints.push(String(text));
  await ctx.newSession();

  assert.notEqual(session.transcript.sessionId, oldId);
  assert.equal(session.project, oldProject);
  assert.equal(session.pinnedProjectId, oldPinnedProjectId);
  assert.equal(session.rt, oldRuntime);
  assert.equal(session.sessionModelRef, 'example/provider-model');
  assert.equal(session.modelCfg, oldModelCfg);
  assert.deepEqual(session.messages, []);
  assert.equal(session.lastAnswer, null);
  assert.equal(session.lastTask, null);
  assert.equal(session.lastCompletedTask, null);
  assert.equal(session.planProgress, null);
  assert.equal(session.lastPlanText, null);
  assert.equal(session.hadPlanThisTurn, false);
  assert.deepEqual(session.sessionFacts, []);
  assert.equal(session.tokens.callIn, 0);
  assert.equal(session.tokens.cumOut, 0);
  assert.equal(session.phase, 'idle');
  assert.equal(session.turnStart, 0);
  assert.notEqual(session.startedAt, oldStartedAt);
  assert.deepEqual(session.userInputQueue, []);
  assert.deepEqual(session.queue, ['queued slash command'], 'ordinary queued input is not session conversation state');

  session.llm = { stream: async function* () {} };
  await dispatchSlash('/review code', ctx);
  assert.ok(prints.some(s => /nothing to review/i.test(s)), JSON.stringify(prints));
});

test('/project set current to the already-bound project is a no-op for conversation state', async () => {
  const { project, session, ctx } = await makeSession();
  session.lastCompletedTask = { userRequest: 'completed task' };
  session.planProgress = { summary: 'live', steps: [{ goal: 'step', status: 'pending' }] };
  const beforeTranscript = session.transcript;

  const result = await ctx.setCurrentProject(project.id);
  assert.equal(result.id, project.id);
  assert.equal(session.lastCompletedTask.userRequest, 'completed task');
  assert.equal(session.planProgress.summary, 'live');
  assert.equal(session.transcript, beforeTranscript);
});

test('resume clears pre-existing completed and plan snapshots when target has no taskstate', async () => {
  const { project, session, ctx } = await makeSession();
  const target = new Transcript(project.id, 'lifecycle-no-state');
  await target.logUser('target conversation');
  dirtyConversation(session);

  assert.equal(await ctx.resumeSession('lifecycle-no-state'), true);
  assert.equal(session.transcript.sessionId, 'lifecycle-no-state');
  assert.equal(session.messages[0].content, 'target conversation');
  assert.equal(session.lastTask, null);
  assert.equal(session.lastCompletedTask, null);
  assert.equal(session.planProgress, null);
  assert.equal(session.lastPlanText, null);
  assert.equal(session.hadPlanThisTurn, false);
  assert.deepEqual(session.kbConflicts, []);
  assert.deepEqual(session.bashSearchCommands, []);
  assert.equal(session.startedAt, target.startedAt);

  session.llm = { stream: async function* () {} };
  const conversation = await ctx.getConversation();
  assert.equal(conversation.requestText, 'target conversation');
  assert.doesNotMatch(JSON.stringify(conversation), /completed old request|old plan/);
});

test('resume restores only matching interrupted taskstate and its unfinished plan', async () => {
  const { project, session, ctx } = await makeSession();
  const target = new Transcript(project.id, 'lifecycle-task');
  await target.logUser('resume this task');
  await saveTaskState(project.id, {
    sessionId: 'lifecycle-task',
    userRequest: 'resume this task',
    taskSummary: 'unfinished',
    planProgress: {
      summary: 'target plan',
      steps: [
        { goal: 'done step', status: 'done', strategies: [] },
        { goal: 'next step', status: 'pending', strategies: [] },
      ],
    },
  });
  dirtyConversation(session);
  assert.equal(await ctx.resumeSession('lifecycle-task'), true);
  assert.equal(session.lastCompletedTask, null);
  assert.equal(session.lastTask.userRequest, 'resume this task');
  assert.equal(session.lastTask.restored, true);
  assert.equal(session.planProgress.summary, 'target plan');
  assert.equal(session.planProgress.steps[1].status, 'pending');
  await clearTaskState(project.id);
});

test('resume does not restore taskstate belonging to another transcript', async () => {
  const { project, session, ctx } = await makeSession();
  const target = new Transcript(project.id, 'lifecycle-mismatch');
  await target.logUser('clean target');
  await saveTaskState(project.id, {
    sessionId: 'some-other-session',
    userRequest: 'wrong task',
    planProgress: { summary: 'wrong', steps: [{ goal: 'x', status: 'pending' }] },
  });
  dirtyConversation(session);

  assert.equal(await ctx.resumeSession('lifecycle-mismatch'), true);
  assert.equal(session.lastTask, null);
  assert.equal(session.lastCompletedTask, null);
  assert.equal(session.planProgress, null);
  assert.equal(session.lastPlanText, null);
  await clearTaskState(project.id);
});
