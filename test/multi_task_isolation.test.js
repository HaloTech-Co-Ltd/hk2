/*-------------------------------------------------------------------------
 *
 * Multi-task isolation tests: parallel `hk2 --project=<X>` sessions must not
 * interfere with each other via the shared `projects.json` `current` pointer.
 *
 * Covers the per-session project-pin mechanism:
 *   - createSession(pinnedProjectId) / buildCtx / reloadAll form a session
 *   - a session pinned to project A keeps resolving A even after another
 *     session (or a parallel process) rewrites the global `current` to B
 *   - /project set current (ctx.setCurrentProject) migrates THIS session's
 *     pin without dragging another pinned session along
 *
 * Run:  node --test test/multi_task_isolation.test.js
 * ----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHome, registerProject, setCurrentProject, getCurrentProject,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { SESSIONS_ROOT } from '../lib/config/home.js';

let __seq = 0;
async function makeSourceDir(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `hk2-multi-${name}-`));
  return dir;
}

// Register two uniquely-named projects in the isolated HK2_HOME and return
// their records. Names are suffixed with a per-call counter so parallel tests
// (which share one HK2_HOME) never collide on the name-match inside
// setCurrentProject().

// Register two projects in the isolated HK2_HOME and return their records.
// Register two uniquely-named projects in the isolated HK2_HOME and return
// their records. Names are suffixed with a per-call counter so parallel tests
// (which share one HK2_HOME) never collide on the name-match inside
// setCurrentProject().
async function setupTwoProjects() {
  await ensureHome();
  const n = ++__seq;
  const srcA = await makeSourceDir(`projA${n}`);
  const srcB = await makeSourceDir(`projB${n}`);
  const a = await registerProject({ name: `projA${n}`, sourcePath: srcA });
  const b = await registerProject({ name: `projB${n}`, sourcePath: srcB });
  return { a, b };
}

test('a pinned session keeps its project after the global current is rewritten', async () => {
  const { a, b } = await setupTwoProjects();

  // Session A is launched with --project=projA -> pinned to A.
  const sessionA = createSession(a.id);
  const ctxA = buildCtx(sessionA);
  await reloadAll(sessionA, ctxA, { project: true, kb: false, model: false });
  assert.equal(sessionA.project?.id, a.id, 'session A should resolve project A');

  // A parallel process / session B launches with --project=projB and (legacy
  // behavior) writes the global `current` pointer to B.
  await setCurrentProject(b.id);
  assert.equal((await getCurrentProject())?.id, b.id, 'global current is now B');

  // Session A reloads (e.g. /model use triggers an internal reload). With the
  // pin, it must STILL resolve A - the global `current` churn must not flip it.
  await reloadAll(sessionA, ctxA, { project: true, kb: false, model: false });
  assert.equal(sessionA.project?.id, a.id, 'session A must stay on A despite global current=B');
});

test('ctx.getCurrentProject honors the pin, not the shared global current', async () => {
  const { a, b } = await setupTwoProjects();
  await setCurrentProject(b.id); // global current -> B

  const sessionA = createSession(a.id); // pinned to A
  const ctxA = buildCtx(sessionA);
  const resolved = await ctxA.getCurrentProject();
  assert.equal(resolved?.id, a.id, 'ctx.getCurrentProject returns the pinned project A');

  // Unpinned session (bare launch) falls back to global current.
  const sessionBare = createSession(null);
  const ctxBare = buildCtx(sessionBare);
  const bareResolved = await ctxBare.getCurrentProject();
  assert.equal(bareResolved?.id, b.id, 'unpinned session falls back to global current (B)');
  // And captures it as its pin (so a later global change won't flip it either).
  assert.equal(ctxBare.pinnedProjectId, b.id, 'bare launch snapshots global current into pin');
});

test('ctx.setCurrentProject migrates only THIS session pin, not another pinned session', async () => {
  const { a, b } = await setupTwoProjects();

  const sessionA = createSession(a.id);
  const ctxA = buildCtx(sessionA);
  await reloadAll(sessionA, ctxA, { project: true, kb: false, model: false });

  const sessionB = createSession(b.id);
  const ctxB = buildCtx(sessionB);
  await reloadAll(sessionB, ctxB, { project: true, kb: false, model: false });

  // Inside session A, the user runs /project set current <projB>.
  const target = await ctxA.setCurrentProject(b.name);
  assert.equal(target?.id, b.id, 'switch resolved projB');
  assert.equal(ctxA.pinnedProjectId, b.id, 'session A pin migrated to B');
  // The shared global pointer is also updated (keeps /project show consistent).
  assert.equal((await getCurrentProject())?.id, b.id, 'global current updated to B');

  // But session B - a separate parallel process - is unaffected: its pin is
  // still B and a reload still resolves B (not flipped, not duplicated).
  await reloadAll(sessionB, ctxB, { project: true, kb: false, model: false });
  assert.equal(sessionB.project?.id, b.id, 'session B stays on B');
  assert.equal(ctxB.pinnedProjectId, b.id, 'session B pin unchanged');
});

test('reloadAll does not clobber an existing transcript when re-resolving the pinned project', async () => {
  const { a } = await setupTwoProjects();
  const session = createSession(a.id);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx, { project: true, kb: false, model: false });
  const firstTranscript = session.transcript;
  assert.ok(firstTranscript, 'transcript created on first reload');
  // Second reload (project flag) must NOT replace the transcript.
  await reloadAll(session, ctx, { project: true, kb: false, model: false });
  assert.equal(session.transcript, firstTranscript, 'transcript preserved across reload');
});

test('/project set current to the SAME project is a no-op — conversation and transcript untouched', async () => {
  const { a } = await setupTwoProjects();
  const session = createSession(a.id);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx, { project: true, kb: false, model: false });
  const transcriptBefore = session.transcript;
  assert.ok(transcriptBefore, 'transcript created on first reload');

  // Simulate a live conversation + non-idle status state.
  session.messages = [{ role: 'user', content: 'hello' }];
  session.tokens.loopPeakIn = 1234;
  session.phase = 'working';

  // Re-typing the same project must change nothing.
  const target = await ctx.setCurrentProject(a.name);
  assert.equal(target?.id, a.id, 'same-project switch resolves the project');
  assert.equal(session.transcript, transcriptBefore, 'transcript object preserved');
  assert.equal(session.transcript.sessionId, transcriptBefore.sessionId, 'session id preserved');
  assert.equal(session.messages.length, 1, 'conversation NOT cleared on a same-project switch');
  assert.equal(session.tokens.loopPeakIn, 1234, 'tokens NOT reset on a same-project switch');
  assert.equal(session.phase, 'working', 'phase NOT reset on a same-project switch');
  assert.deepEqual(session.reloadFlags, { project: false, kb: false, model: false }, 'no pending reload flags');
});

test('/project set current to a DIFFERENT project starts a fresh session (save old, new transcript under new project, reset state)', async () => {
  const { a, b } = await setupTwoProjects();
  const session = createSession(a.id);
  const ctx = buildCtx(session);
  await reloadAll(session, ctx, { project: true, kb: false, model: false });
  const oldTranscript = session.transcript;
  assert.ok(oldTranscript, 'transcript for project A created');
  assert.equal(oldTranscript.projectId, a.id);

  // Simulate an in-flight conversation on A plus non-idle status state.
  session.messages = [{ role: 'user', content: 'work on A' }];
  session.tokens.loopPeakIn = 4321;
  session.phase = 'working';

  // Switch to B — equivalent to /quit + `hk2 --project=B`.
  const target = await ctx.setCurrentProject(b.name);
  assert.equal(target?.id, b.id, 'switch resolved projB');
  assert.equal(ctx.pinnedProjectId, b.id, 'session pin migrated to B');
  assert.equal((await getCurrentProject())?.id, b.id, 'global current updated to B');

  // The OLD conversation was finalized on disk under project A, stamped as a
  // project_switch, before the transcript was swapped.
  const oldRaw = await fs.readFile(oldTranscript.path, 'utf8');
  assert.ok(oldRaw.includes('"type":"meta"'), 'meta events present in old transcript');
  const lines = oldRaw.split('\n').filter(l => l.trim());
  const metaLines = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.type === 'meta');
  const sw = metaLines.find(e => e.key === 'project_switch');
  assert.ok(sw, 'project_switch meta marker written');
  assert.equal(sw.value.from, a.id);
  assert.equal(sw.value.to, b.id);

  // A NEW transcript was created for project B (different file, B's dir).
  assert.notEqual(session.transcript, oldTranscript, 'transcript object replaced');
  assert.ok(session.transcript, 'new transcript exists');
  assert.equal(session.transcript.projectId, b.id, 'new transcript belongs to project B');
  assert.notEqual(session.transcript.sessionId, oldTranscript.sessionId, 'new session id');
  assert.ok(session.transcript.path.startsWith(path.join(SESSIONS_ROOT, b.id) + path.sep),
    `new transcript path under project B's sessions dir (got ${session.transcript.path})`);

  // Fresh-session state: context, status bar state, flags all reset.
  assert.equal(session.messages.length, 0, 'messages cleared');
  assert.equal(session.lastAnswer, null);
  assert.equal(session.lastTask, null);
  assert.equal(session.planProgress, null);
  assert.equal(session.phase, 'idle', 'phase reset');
  assert.equal(session.turnStart, 0, 'turnStart reset');
  assert.equal(session.tokens.loopPeakIn, 0, 'token counters reset');
  assert.deepEqual(session.reloadFlags, { project: false, kb: false, model: false }, 'reload flags consumed');
  assert.equal(session.project?.id, b.id, 'session.project resolved to B');
  assert.equal(process.env.HK2_PROJECT_SOURCE, b.sourcePath, 'HK2_PROJECT_SOURCE points at B');
});
