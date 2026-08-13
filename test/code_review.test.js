/*-------------------------------------------------------------------------
 *
 * Code Review tests.
 *
 * Two concerns:
 *   1. Config: the `code-review` phase is registered in PHASE_KEYS so the
 *      /model set-phase machinery (normalizePhaseName, supportedPhaseNames,
 *      get/set/clearPhaseModelRef) treats it exactly like `rewrite-query` and
 *      `plan-review`.
 *   2. reviewCode(): parses the reviewer's JSON into issues, coerces bad
 *      shapes safely, and degrades gracefully (returns {ok:true}) on any
 *      failure (empty text, non-JSON output, LLM exception, ok without issues,
 *      not-ok with no usable issues) so the caller never blocks.
 *   3. buildCodeReviewContent(): frames the plan / changed files / diff /
 *      final answer as a review target and truncates oversized diffs.
 *
 * The review LLM is faked with a tiny async generator that yields delta
 * events, matching the LLMClient.stream contract reviewCode relies on.
 *
 * Run:  node --test test/code_review.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHome, loadModels, saveModels,
  registerProject, setCurrentProject, getCurrentProject,
  getPhaseModelRef, setPhaseModelRef, clearPhaseModelRef,
  normalizePhaseName, supportedPhaseNames,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll, collectWorkingTreeDiff } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';
import { reviewCode, buildCodeReviewContent } from '../lib/agent/code_review.js';

let __seq = 0;
async function makeSourceDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-crev-${name}-`));
}

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
  const src = await makeSourceDir(`${name}${n}`);
  return registerProject({ name: `${name}${n}`, sourcePath: src });
}

// Fake LLM: yields the given text as a single delta event, matching the
// {type:'delta', text} contract reviewCode consumes from llm.stream().
function fakeLlm(outputText) {
  return {
    stream: async function* () {
      yield { type: 'delta', text: outputText };
    },
  };
}

// Fake LLM that throws inside stream - simulates an LLM call failure.
function throwingLlm(err = new Error('boom')) {
  return {
    stream: async function* () { throw err; },
  };
}

// ---------------------------------------------------------------------------
// 1. Config: code-review phase is registered like rewrite-query / plan-review
// ---------------------------------------------------------------------------

test('normalizePhaseName maps code-review to the storage key', () => {
  assert.equal(normalizePhaseName('code-review'), 'codeReview');
  assert.equal(normalizePhaseName('Code-Review'), 'codeReview'); // case-insensitive
  assert.equal(normalizePhaseName('code_review'), null); // underscore form NOT accepted
  assert.equal(normalizePhaseName(''), null);
  assert.equal(normalizePhaseName(null), null);
});

test('supportedPhaseNames advertises code-review', () => {
  const names = supportedPhaseNames();
  assert.ok(names.includes('code-review'), `expected code-review in ${JSON.stringify(names)}`);
  assert.ok(names.includes('plan-review'), 'plan-review still present');
  assert.ok(names.includes('rewrite-query'), 'rewrite-query still present');
});

test('setPhaseModelRef persists and getPhaseModelRef reads back code-review', async () => {
  await seedModels();
  const p = await makeProject('setget');
  assert.equal(getPhaseModelRef(p, 'code-review'), null, 'no override before set');

  const updated = await setPhaseModelRef(p.id, 'code-review', 'provB/model-b');
  assert.ok(updated, 'setPhaseModelRef returned the updated record');
  assert.equal(updated.phaseModels?.codeReview, 'provB/model-b', 'stored under the storage key');
  assert.equal(getPhaseModelRef(updated, 'code-review'), 'provB/model-b', 'read back via CLI name');

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'code-review'), 'provB/model-b', 'persisted across reload');
});

test('clearPhaseModelRef removes the code-review override and preserves others', async () => {
  await seedModels();
  const p = await makeProject('clear');
  await setPhaseModelRef(p.id, 'code-review', 'provB/model-b');
  await setPhaseModelRef(p.id, 'plan-review', 'provB/model-b');

  const cleared = await clearPhaseModelRef(p.id, 'code-review');
  assert.ok(cleared, 'clear returned the updated record');
  assert.equal(getPhaseModelRef(cleared, 'code-review'), null, 'code-review override removed');
  assert.equal(getPhaseModelRef(cleared, 'plan-review'), 'provB/model-b', 'plan-review preserved');
});

test('/model set-phase persists code-review on the current project', async () => {
  await seedModels();
  const p = await makeProject('cli');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  const handled = await dispatchSlash('/model set-phase --phase=code-review provB/model-b', ctx);
  assert.equal(handled, true, 'dispatchSlash handled the command');
  assert.ok(
    prints.some((s) => s.includes('Phase model set') && s.includes('code-review') && s.includes('provB/model-b')),
    `expected a confirmation, got: ${JSON.stringify(prints)}`,
  );

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'code-review'), 'provB/model-b', 'persisted on the project');
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model unchanged');
});

// ---------------------------------------------------------------------------
// 2. reviewCode(): JSON parsing, coercion, graceful fallback
// ---------------------------------------------------------------------------

const SAMPLE_REVIEW = '=== PLAN (begin) ===\nSummary: do X\n=== PLAN (end) ===\n=== DIFF (begin) ===\n+foo\n=== DIFF (end) ===';

test('reviewCode returns ok with no issues when the reviewer approves', async () => {
  const out = '{"ok": true, "issues": []}';
  const result = await reviewCode(fakeLlm(out), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewCode parses issues when the reviewer finds problems', async () => {
  const out = JSON.stringify({
    ok: false,
    issues: [
      {
        title: 'Missing error handling in lib/foo.js',
        detail: 'The new read path throws without a try/catch, unlike callers.',
        suggestion: 'Wrap the read in the same error handling used elsewhere.',
      },
      {
        title: 'Unrelated file changed',
        detail: 'package-lock.json was modified but the plan did not touch deps.',
        suggestion: 'Revert package-lock.json.',
      },
    ],
  });
  const result = await reviewCode(fakeLlm(out), SAMPLE_REVIEW);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 2);
  assert.equal(result.issues[0].title, 'Missing error handling in lib/foo.js');
  assert.equal(result.issues[0].suggestion.includes('same error handling'), true);
  assert.equal(result.issues[1].detail.includes('package-lock.json'), true);
});

test('reviewCode tolerates markdown-fenced JSON', async () => {
  const out = '```json\n{"ok": false, "issues": [{"title": "x", "detail": "d", "suggestion": "s"}]}\n```';
  const result = await reviewCode(fakeLlm(out), SAMPLE_REVIEW);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, 'x');
});

test('reviewCode drops issues missing a title', async () => {
  const out = JSON.stringify({
    ok: false,
    issues: [
      { title: 'keep me', detail: 'd', suggestion: 's' },
      { detail: 'no title', suggestion: 's' },
      { title: '   ', detail: 'd', suggestion: 's' },
    ],
  });
  const result = await reviewCode(fakeLlm(out), SAMPLE_REVIEW);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].title, 'keep me');
});

test('reviewCode treats ok-without-issues and not-ok-with-no-issues as ok', async () => {
  let result = await reviewCode(fakeLlm('{"issues": []}'), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  result = await reviewCode(fakeLlm('{"ok": true, "issues": [{"title":"x"}]}'), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  result = await reviewCode(fakeLlm('{"ok": false, "issues": []}'), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  result = await reviewCode(fakeLlm('{"ok": false, "issues": "string"}'), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewCode returns ok on a non-JSON LLM output', async () => {
  const result = await reviewCode(fakeLlm('sorry, I cannot review that'), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewCode returns ok when the LLM stream throws', async () => {
  const result = await reviewCode(throwingLlm(new Error('network down')), SAMPLE_REVIEW);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('reviewCode returns ok for an empty review text', async () => {
  const result = await reviewCode(fakeLlm('{"ok": false, "issues": [{"title":"x"}]}'), '');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);

  const result2 = await reviewCode(fakeLlm('{"ok": false, "issues": [{"title":"x"}]}'), '   ');
  assert.equal(result2.ok, true);
});

test('reviewCode forwards the abort signal to the LLM stream', async () => {
  let receivedSignal = null;
  const llm = {
    stream: async function* (_messages, opts) {
      receivedSignal = opts?.signal;
      yield { type: 'delta', text: '{"ok": true, "issues": []}' };
    },
  };
  const ac = new AbortController();
  await reviewCode(llm, SAMPLE_REVIEW, { signal: ac.signal });
  assert.equal(receivedSignal, ac.signal, 'signal was forwarded to the stream');
});

// ---------------------------------------------------------------------------
// 3. buildCodeReviewContent(): section framing + diff truncation
// ---------------------------------------------------------------------------

test('buildCodeReviewContent frames every provided section', () => {
  const text = buildCodeReviewContent({
    planText: 'Summary: do X',
    changedFiles: ['lib/foo.js', 'src/bar.js'],
    diffText: '+const x = 1;',
    answerText: 'Done.',
  });
  assert.ok(text.includes('CODE REVIEW'), 'has the task declaration');
  assert.ok(text.includes('Summary: do X'), 'includes the plan');
  assert.ok(text.includes('lib/foo.js'), 'includes changed files');
  assert.ok(text.includes('+const x = 1;'), 'includes the diff');
  assert.ok(text.includes('Done.'), 'includes the final answer');
});

test('buildCodeReviewContent handles empty inputs gracefully', () => {
  const text = buildCodeReviewContent({});
  assert.ok(text.includes('CODE REVIEW'), 'has the task declaration');
  assert.ok(text.includes('no working-tree diff was available'), 'notes the missing diff');
  assert.ok(!text.includes('=== PLAN'), 'no plan section when absent');
  assert.ok(!text.includes('ASSISTANT FINAL ANSWER'), 'no answer section when absent');
});

test('buildCodeReviewContent truncates oversized diffs', () => {
  const big = 'x'.repeat(60000);
  const text = buildCodeReviewContent({ diffText: big });
  assert.ok(text.includes('diff truncated'), 'announces the truncation');
  assert.ok(text.length < 60000, 'diff body was truncated');
});

// ---------------------------------------------------------------------------
// 4. collectWorkingTreeDiff(): real-git regression (was silently broken: git
//    "-C" was placed AFTER the subcommand, so `git status -C <path>` and
//    `git ls-files -C <path>` errored with "unknown switch C", emptying
//    changedFiles and skipping untracked-file collection entirely).
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function gitInitWithChange(repoPath) {
  await execFileP('git', ['-C', repoPath, 'init', '-q']);
  await execFileP('git', ['-C', repoPath, 'config', 'user.email', 't@t']);
  await execFileP('git', ['-C', repoPath, 'config', 'user.name', 't']);
  // Tracked file: committed, then modified.
  await fs.writeFile(path.join(repoPath, 'existing.js'), 'a();\n');
  await execFileP('git', ['-C', repoPath, 'add', 'existing.js']);
  await execFileP('git', ['-C', repoPath, 'commit', '-qm', 'init']);
  await fs.writeFile(path.join(repoPath, 'existing.js'), 'a();\nb();\n');
  // New (untracked) file: the most important artifact to review.
  await fs.writeFile(path.join(repoPath, 'new-feature.js'), 'export const x = 1;\n');
}

test('collectWorkingTreeDiff returns modified tracked file and changed file list', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-crev-git-'));
  await gitInitWithChange(repo);
  const { diffText, changedFiles } = await collectWorkingTreeDiff(repo);
  assert.ok(changedFiles.includes('existing.js'), `tracked mod in changedFiles: ${JSON.stringify(changedFiles)}`);
  assert.ok(diffText.includes('b();'), 'tracked diff body present');
});

test('collectWorkingTreeDiff captures untracked new-file content (regression: was dropped)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-crev-git-'));
  await gitInitWithChange(repo);
  const { diffText, changedFiles } = await collectWorkingTreeDiff(repo);
  // The untracked file's content MUST appear in the review diff.
  assert.ok(
    diffText.includes('export const x = 1;'),
    `untracked file content included: diff was ${diffText.slice(0, 120)}...`,
  );
  assert.ok(changedFiles.includes('new-feature.js'), `untracked file listed in changedFiles: ${JSON.stringify(changedFiles)}`);
});

test('collectWorkingTreeDiff degrades gracefully outside a git repo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-crev-nogit-'));
  const { diffText, changedFiles } = await collectWorkingTreeDiff(dir);
  assert.deepEqual(changedFiles, []);
  assert.equal(diffText, '');
});

test('collectWorkingTreeDiff returns empty for a missing source path', async () => {
  const { diffText, changedFiles } = await collectWorkingTreeDiff('');
  assert.deepEqual(changedFiles, []);
  assert.equal(diffText, '');
});
