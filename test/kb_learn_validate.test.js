/*-------------------------------------------------------------------------
 *
 * Unit tests for KB learn validation (lib/agent/kb_validate.js + the wiring
 * inside learnNewKnowledge in src/commands/interactive.js).
 *
 * Covers the three requirements:
 *   1. Similar content already in the KB → update the original entry, or
 *      create a new entry WITH a stated reason for not updating.
 *   2. Conflicts → Eden conflicts follow the validator verdict + reason;
 *      Holy conflicts ALWAYS defer to the user.
 *   3. Same / essentially identical content → skip entirely (no duplicate
 *      learning).
 *
 * Run:  node --test test/kb_learn_validate.test.js
 *---------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createSession, buildCtx } from '../src/commands/interactive.js';
import { ensureHome, registerProject, setCurrentProject } from '../lib/config/home.js';
import { writeKnowledge, readKnowledge, listKnowledge } from '../lib/store/kb_store.js';
import {
  findCandidateEntries,
  coerceVerdict,
  fallbackVerdict,
  validateLearnedEntry,
} from '../lib/agent/kb_validate.js';

/* ----- helpers ------------------------------------------------------- */

const HOLY_A = {
  id: 'release-workflow', space: 'holy',
  title: 'Release workflow: version bump, test gate, commit, push',
  keywords: ['release', 'version', 'commit', 'push'],
  intro: 'Releasing involves four steps: bump version, run tests, commit, push.',
};
const EDEN_B = {
  id: 'sql-commands', space: 'eden',
  title: 'SQL Command Catalog',
  keywords: ['sql', 'commands', 'catalog'],
  intro: 'A list of supported SQL commands.',
};

function mockCtx({ confirmAnswer = false, confirmAnswers = null } = {}) {
  const lines = [];
  let queue = confirmAnswers ? [...confirmAnswers] : null;
  return {
    lines,
    print: (s) => lines.push(s),
    confirm: async () => {
      if (queue) return queue.length ? queue.shift() : false;
      return confirmAnswer;
    },
  };
}

/**
 * Build a session whose LLM plays BOTH the learn-extraction call and the
 * (optional) validation call. `responses` is consumed in order: the first
 * goes to the extraction prompt, the second (when present) to the validator.
 */
function mockSession({ responses = [], } = {}) {
  const s = createSession();
  s.project = { id: 'test-proj', name: 'test-proj', sourcePath: '/tmp/x' };
  s.bashSearchCommands = [];
  s.messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'did the thing' },
  ];
  const q = [...responses];
  s.llm = {
    stream: async function* (messages) {
      // The validator prompt is distinguishable by its system content.
      const isValidator = messages?.[0]?.content?.includes('validating a newly-learned knowledge entry');
      const raw = q.length > 1
        ? (isValidator ? q[1] : q[0])
        : (q[0] ?? '{"skip": true}');
      yield { type: 'delta', text: raw };
    },
  };
  return s;
}

async function setupProjectDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-lv-'));
  await fs.writeFile(path.join(dir, 'a.js'), 'const x = 1;\n');
  return dir;
}

let __projSeq = 0;
async function setupRealProject() {
  await ensureHome();
  const dir = await setupProjectDir();
  const name = `lv-test-${++__projSeq}-${Date.now()}`;
  const project = await registerProject({ name, sourcePath: dir });
  await setCurrentProject(project.id);
  return project;
}

/* ===== Part 1: findCandidateEntries (deterministic pre-filter) ===== */

test('findCandidateEntries: id hit → relatedness 1.0', () => {
  const out = findCandidateEntries({ id: 'release-workflow', title: 'x', keywords: [] }, [HOLY_A], [EDEN_B]);
  assert.equal(out.length, 1);
  assert.equal(out[0].entry.id, 'release-workflow');
  assert.equal(out[0].space, 'holy');
  assert.equal(out[0].relatedness, 1);
});

test('findCandidateEntries: title mutual containment → 0.9', () => {
  const out = findCandidateEntries(
    { id: 'other', title: 'SQL Command Catalog (extended)', keywords: [] },
    [],
    [EDEN_B],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].relatedness, 0.9);
});

test('findCandidateEntries: keyword overlap > 0.6 → ratio', () => {
  const out = findCandidateEntries(
    { id: 'other', title: 'unrelated title', keywords: ['release', 'version', 'commit', 'push'] },
    [HOLY_A],
    [],
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].relatedness > 0.6);
});

test('findCandidateEntries: unrelated → empty', () => {
  const out = findCandidateEntries(
    { id: 'other', title: 'totally different', keywords: ['docker', 'network'] },
    [HOLY_A],
    [EDEN_B],
  );
  assert.equal(out.length, 0);
});

test('findCandidateEntries: sorted by relatedness desc', () => {
  const out = findCandidateEntries(
    { id: 'sql-commands', title: 'SQL Command Catalog', keywords: ['release', 'version', 'commit', 'extra'] },
    [HOLY_A],
    [EDEN_B],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].entry.id, 'sql-commands'); // id hit 1.0 beats keyword overlap 0.75
  assert.equal(out[0].relatedness, 1);
  assert.equal(out[1].entry.id, 'release-workflow');
});

/* ===== Part 2: coerceVerdict / fallback ============================= */

test('coerceVerdict keeps a well-formed update verdict', () => {
  const v = coerceVerdict(
    { verdict: 'update', targetId: 'release-workflow', reason: 'same topic', mergedIntro: 'merged text' },
    [{ entry: HOLY_A, space: 'holy', relatedness: 1 }],
  );
  assert.equal(v.verdict, 'update');
  assert.equal(v.targetId, 'release-workflow');
  assert.equal(v.mergedIntro, 'merged text');
});

test('coerceVerdict drops hallucinated targetId to new', () => {
  const v = coerceVerdict(
    { verdict: 'update', targetId: 'no-such-entry', reason: 'x', mergedIntro: 'y' },
    [{ entry: HOLY_A, space: 'holy', relatedness: 1 }],
  );
  assert.equal(v.verdict, 'new');
  assert.equal(v.targetId, null);
});

test('coerceVerdict: update without mergedIntro degrades to new', () => {
  const v = coerceVerdict(
    { verdict: 'update', targetId: 'release-workflow', reason: 'x' },
    [{ entry: HOLY_A, space: 'holy', relatedness: 1 }],
  );
  assert.equal(v.verdict, 'new');
});

test('coerceVerdict: conflict without winner defaults to existing (conservative)', () => {
  const v = coerceVerdict(
    { verdict: 'conflict', targetId: 'release-workflow', reason: 'x' },
    [{ entry: HOLY_A, space: 'holy', relatedness: 1 }],
  );
  assert.equal(v.verdict, 'conflict');
  assert.equal(v.conflictWinner, 'existing');
});

test('fallbackVerdict shape', () => {
  const v = fallbackVerdict('boom');
  assert.equal(v.verdict, 'new');
  assert.equal(v.targetId, null);
  assert.ok(v.fallback);
});

/* ===== Part 3: validateLearnedEntry (LLM call + degradation) ======== */

test('validateLearnedEntry: no candidates → new without LLM call', async () => {
  let calls = 0;
  const llm = { stream: async function* () { calls++; yield { type: 'delta', text: '{}' }; } };
  const v = await validateLearnedEntry(llm, { id: 'a', title: 'a' }, []);
  assert.equal(v.verdict, 'new');
  assert.equal(calls, 0);
});

test('validateLearnedEntry: parse verdict from fenced JSON', async () => {
  const llm = { stream: async function* () {
    yield { type: 'delta', text: '```json\n{"verdict":"duplicate","targetId":"release-workflow","reason":"same meaning"}\n```' };
  } };
  const v = await validateLearnedEntry(llm, { id: 'a', title: 'a', intro: 'x' }, [{ entry: HOLY_A, space: 'holy', relatedness: 1 }]);
  assert.equal(v.verdict, 'duplicate');
  assert.equal(v.targetId, 'release-workflow');
});

test('validateLearnedEntry: LLM failure degrades to new', async () => {
  const llm = { stream: async function* () { throw new Error('network down'); } };
  const v = await validateLearnedEntry(llm, { id: 'a', title: 'a' }, [{ entry: HOLY_A, space: 'holy', relatedness: 1 }]);
  assert.equal(v.verdict, 'new');
  assert.ok(v.fallback);
});

test('validateLearnedEntry: unparseable output degrades to new', async () => {
  const llm = { stream: async function* () { yield { type: 'delta', text: 'I think it is a duplicate of the other one' }; } };
  const v = await validateLearnedEntry(llm, { id: 'a', title: 'a' }, [{ entry: HOLY_A, space: 'holy', relatedness: 1 }]);
  assert.equal(v.verdict, 'new');
  assert.ok(v.fallback);
});

/* ===== Part 4: learnNewKnowledge wiring (real store, mocked LLM) ===== */

// Drive learnNewKnowledge indirectly through maybeOfferKbUpdate? It prompts
// for /kb update first. Instead call the internal path via the exported
// buildCtx + session shape and the module's own function. learnNewKnowledge
// is not exported, so exercise the wiring through maybeOfferKbUpdate with
// confirm=true (auto-accept the /kb update prompt).

async function driveLearn(session, ctx) {
  const { maybeOfferKbUpdate } = await import('../src/commands/interactive.js');
  session.bashSearchCommands = ['grep -r foo src/']; // arm the end-of-turn hook
  await maybeOfferKbUpdate(session, ctx);
}

test('wiring: duplicate verdict → skip the write entirely', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'holy', { ...HOLY_A });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'holy', id: 'release-workflow-v2', title: 'Release workflow', intro: 'Releasing involves four steps: bump version, run tests, commit, push.', keywords: ['release', 'version'] }),
    JSON.stringify({ verdict: 'duplicate', targetId: 'release-workflow', reason: 'same meaning as the existing entry' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true] }); // accept /kb update
  await driveLearn(session, ctx);
  const skipLine = ctx.lines.find(l => l.includes('already contains the same knowledge'));
  assert.ok(skipLine, `expected duplicate skip notice, got: ${JSON.stringify(ctx.lines)}`);
  assert.ok(skipLine.includes('release-workflow'));
  assert.ok(ctx.lines.some(l => l.includes('reason:')));
  // Nothing new written.
  const holy = await listKnowledge(project.id, 'holy');
  assert.equal(holy.filter(e => e.id === 'release-workflow-v2').length, 0);
  assert.ok(session.kbLearnHandledAt > 0, 'handled anchor must be set');
});

test('wiring: update verdict → merged onto the existing entry', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'eden', { ...EDEN_B, intro: 'Old short list.' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'sql-commands-v2', title: 'SQL Commands', intro: 'Extended SQL command list with DDL.', keywords: ['sql', 'commands'] }),
    JSON.stringify({ verdict: 'update', targetId: 'sql-commands', reason: 'same topic, fresher content', mergedIntro: 'Old short list. Extended SQL command list with DDL.' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] }); // /kb update + eden commit
  await driveLearn(session, ctx);
  const merged = await readKnowledge(project.id, 'eden', 'sql-commands');
  assert.ok(merged, 'the existing entry must be updated in place');
  assert.ok(merged.intro.includes('Extended SQL command list'));
  assert.equal(await readKnowledge(project.id, 'eden', 'sql-commands-v2'), null, 'no sibling entry created');
  assert.ok(ctx.lines.some(l => l.includes('merging into it')), 'merge notice expected');
});

test('wiring: holy conflict → user decides (declined → original wins, nothing written)', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'holy', { ...HOLY_A, intro: 'Version bump edits package.json only.' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'holy', id: 'release-workflow-v2', title: 'Release workflow', intro: 'Version bump edits package.json AND package-lock.json.', keywords: ['release', 'version'] }),
    JSON.stringify({ verdict: 'conflict', targetId: 'release-workflow', reason: 'the lock file sync was observed this turn', conflictWinner: 'new' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, false] }); // /kb update yes, holy-conflict y/N → NO
  await driveLearn(session, ctx);
  assert.ok(ctx.lines.some(l => l.includes('CONFLICTS with holy:"release-workflow"')), 'conflict notice expected');
  assert.ok(ctx.lines.some(l => l.includes('keeping the existing Holy entry')), 'decline notice expected');
  const holy = await readKnowledge(project.id, 'holy', 'release-workflow');
  assert.ok(holy.intro.includes('package.json only'), 'original intro must be untouched');
});

test('wiring: holy conflict → user approves → original entry updated', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'holy', { ...HOLY_A, intro: 'Version bump edits package.json only.' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'holy', id: 'release-workflow-v2', title: 'Release workflow', intro: 'Version bump edits package.json AND package-lock.json.', keywords: ['release', 'version'] }),
    JSON.stringify({ verdict: 'conflict', targetId: 'release-workflow', reason: 'lock file sync observed', conflictWinner: 'new' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] }); // /kb update yes, holy-conflict → YES
  await driveLearn(session, ctx);
  const holy = await readKnowledge(project.id, 'holy', 'release-workflow');
  assert.ok(holy.intro.includes('package-lock.json'), 'the original entry must carry the new knowledge');
  assert.equal(await readKnowledge(project.id, 'holy', 'release-workflow-v2'), null, 'no sibling entry');
});

test('wiring: eden conflict, new wins → new entry written + old kept + notice', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'eden', { ...EDEN_B, intro: 'Timeout is 300s.' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'sql-commands-v2', title: 'SQL Command Catalog', intro: 'Timeout is 600s.', keywords: ['sql', 'commands'] }),
    JSON.stringify({ verdict: 'conflict', targetId: 'sql-commands', reason: 'code now sets 600000ms', conflictWinner: 'new' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] }); // /kb update + eden commit
  await driveLearn(session, ctx);
  const both = await listKnowledge(project.id, 'eden');
  assert.ok(both.find(e => e.id === 'sql-commands'), 'old entry kept');
  assert.ok(both.find(e => e.id === 'sql-commands-v2'), 'new entry written');
  assert.ok(ctx.lines.some(l => l.includes('The new entry is written')), 'user-facing notice expected');
});

test('wiring: eden conflict, existing wins → nothing written', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'eden', { ...EDEN_B, intro: 'Timeout is 600s.' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'sql-commands-v2', title: 'SQL Command Catalog', intro: 'Timeout is 300s.', keywords: ['sql', 'commands'] }),
    JSON.stringify({ verdict: 'conflict', targetId: 'sql-commands', reason: 'new extraction looks stale', conflictWinner: 'existing' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true] });
  await driveLearn(session, ctx);
  assert.ok(ctx.lines.some(l => l.includes('the existing entry wins')), 'existing-wins notice expected');
  const both = await listKnowledge(project.id, 'eden');
  assert.equal(both.filter(e => e.id === 'sql-commands-v2').length, 0, 'nothing written');
});

test('wiring: verdict new with related candidates → states the not-updating reason', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'holy', { ...HOLY_A });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'docker-notes', title: 'Release workflow containerization notes', intro: 'How to containerize the release pipeline.', keywords: ['release'] }),
    JSON.stringify({ verdict: 'new', targetId: null, reason: 'different aspect: containers, not the release steps themselves', conflictWinner: null, mergedIntro: null }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] }); // /kb update + eden commit
  await driveLearn(session, ctx);
  const reasonLine = ctx.lines.find(l => l.includes('creating a NEW entry'));
  assert.ok(reasonLine, 'not-updating reason notice expected');
  assert.ok(ctx.lines.some(l => l.includes('containers, not the release steps')), 'the validator reason must be surfaced');
  assert.ok(await readKnowledge(project.id, 'eden', 'docker-notes'), 'new entry persisted');
});

test('wiring: no candidates at all → new entry, no validator notice', async () => {
  const project = await setupRealProject();
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'brand-new-topic', title: 'Brand new', intro: 'fresh', keywords: ['unrelated', 'stuff'] }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] });
  await driveLearn(session, ctx);
  assert.ok(!ctx.lines.some(l => l.includes('creating a NEW entry')), 'no not-updating notice when no candidates');
  assert.ok(await readKnowledge(project.id, 'eden', 'brand-new-topic'), 'entry persisted');
});

test('wiring: update merge preserves the original createdAt', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'eden', { ...EDEN_B, intro: 'Old short list.', createdAt: '2020-01-01T00:00:00.000Z' });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'eden', id: 'sql-commands-v2', title: 'SQL Commands', intro: 'Extended list.', keywords: ['sql', 'commands'] }),
    JSON.stringify({ verdict: 'update', targetId: 'sql-commands', reason: 'same topic', mergedIntro: 'Old short list. Extended list.' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] });
  await driveLearn(session, ctx);
  const merged = await readKnowledge(project.id, 'eden', 'sql-commands');
  assert.equal(merged.createdAt, '2020-01-01T00:00:00.000Z', 'createdAt must survive an update-merge');
});

test('wiring: superseded eden entries are never merge targets (stamp must not be stripped)', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'eden', {
    ...EDEN_B, intro: 'Retired list.',
    supersededBy: 'holy:some-holy-entry', supersededAt: '2021-01-01T00:00:00.000Z',
  });
  const session = mockSession({ responses: [
    // Validator verdicts are irrelevant here: the retired entry must never
    // even reach the candidate list, so this verdict is never applied to it.
    JSON.stringify({ space: 'eden', id: 'sql-commands-v2', title: 'SQL Commands', intro: 'Fresh list.', keywords: ['sql', 'commands'] }),
    JSON.stringify({ verdict: 'update', targetId: 'sql-commands', reason: 'x', mergedIntro: 'merged' }),
  ] });
  session.project = project;
  const ctx = mockCtx({ confirmAnswers: [true, true] });
  await driveLearn(session, ctx);
  const retired = await readKnowledge(project.id, 'eden', 'sql-commands');
  assert.equal(retired.supersededBy, 'holy:some-holy-entry', 'supersession stamp must survive any learn write');
  assert.equal(retired.intro, 'Retired list.', 'retired entry content must be untouched');
  assert.equal(retired.updatedByLearn, undefined, 'the update must not have been applied onto the retired entry');
});

test('wiring: HK2_KB_LEARN_VALIDATE=0 disables validation entirely', async () => {
  const project = await setupRealProject();
  await writeKnowledge(project.id, 'holy', { ...HOLY_A });
  const session = mockSession({ responses: [
    JSON.stringify({ space: 'holy', id: 'release-workflow-v2', title: 'Release workflow', intro: 'same thing again', keywords: ['release'] }),
  ] });
  session.project = project;
  process.env.HK2_KB_LEARN_VALIDATE = '0';
  try {
    const ctx = mockCtx({ confirmAnswers: [true, false] }); // /kb update yes, holy commit NO
    await driveLearn(session, ctx);
    assert.ok(!ctx.lines.some(l => l.includes('[kb learn validate]')), 'validation must be disabled');
  } finally {
    delete process.env.HK2_KB_LEARN_VALIDATE;
  }
});
