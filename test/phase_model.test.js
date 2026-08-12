/*-------------------------------------------------------------------------
 *
 * Per-project phase model configuration tests.
 *
 * `/model set-phase --phase=<rewrite-query> <provider>/<model-id>` configures a
 * model override for the rewrite-query phase on the CURRENT project. When set,
 * the rewrite pass runs on that model instead of the current session model;
 * when unset (the default), the session model is used.
 *
 * These tests lock in:
 *   1. config helpers getPhaseModelRef / setPhaseModelRef / clearPhaseModelRef
 *      (normalize, persist, merge across phases, clear).
 *   2. the CLI subcommand persists, rejects unknown phases / bad refs, supports
 *      --clear, and is per-project (project B is unaffected by project A's
 *      override).
 *   3. runAgentTurn resolves the phase LLM and would use it for the rewrite
 *      (verified by exercising the resolver path directly, since the full turn
 *      needs a live KB + LLM stream).
 *
 * Run:  node --test test/phase_model.test.js
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
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

let __seq = 0;
async function makeSourceDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-phase-${name}-`));
}

// Seed models.json with two providers/models and a default.
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

// Register a project in the isolated HK2_HOME and return its record.
async function makeProject(name) {
  const n = ++__seq;
  const src = await makeSourceDir(`${name}${n}`);
  return registerProject({ name: `${name}${n}`, sourcePath: src });
}

// ---------------------------------------------------------------------------
// 1. Config helpers
// ---------------------------------------------------------------------------

test('normalizePhaseName maps the CLI name to the storage key', () => {
  assert.equal(normalizePhaseName('rewrite-query'), 'rewriteQuery');
  assert.equal(normalizePhaseName('Rewrite-Query'), 'rewriteQuery'); // case-insensitive
  assert.equal(normalizePhaseName('unknown-phase'), null);
  assert.equal(normalizePhaseName(''), null);
  assert.equal(normalizePhaseName(null), null);
});

test('supportedPhaseNames advertises rewrite-query', () => {
  const names = supportedPhaseNames();
  assert.ok(names.includes('rewrite-query'), `expected rewrite-query in ${JSON.stringify(names)}`);
});

test('setPhaseModelRef persists and getPhaseModelRef reads it back', async () => {
  await seedModels();
  const p = await makeProject('setget');
  assert.equal(getPhaseModelRef(p, 'rewrite-query'), null, 'no override before set');

  const updated = await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');
  assert.ok(updated, 'setPhaseModelRef returned the updated record');
  assert.equal(updated.phaseModels?.rewriteQuery, 'provB/model-b', 'stored under the storage key');
  assert.equal(getPhaseModelRef(updated, 'rewrite-query'), 'provB/model-b', 'read back via CLI name');

  // Reload from disk to prove it persisted.
  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'rewrite-query'), 'provB/model-b', 'persisted across reload');
});

test('clearPhaseModelRef removes the override and preserves other phases', async () => {
  await seedModels();
  const p = await makeProject('clear');
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');

  const cleared = await clearPhaseModelRef(p.id, 'rewrite-query');
  assert.ok(cleared, 'clear returned the updated record');
  assert.equal(getPhaseModelRef(cleared, 'rewrite-query'), null, 'override removed');
  assert.ok(!('rewriteQuery' in (cleared.phaseModels || {})), 'key absent from phaseModels');
});

test('clearPhaseModelRef on an unset phase is a no-op (returns record)', async () => {
  await seedModels();
  const p = await makeProject('noop');
  const before = await getCurrentProject();
  const res = await clearPhaseModelRef(p.id, 'rewrite-query');
  assert.ok(res, 'returns the record');
  assert.equal(getPhaseModelRef(res, 'rewrite-query'), null);
  // phaseModels stays a plain object (normalized on load).
  assert.ok(res.phaseModels && typeof res.phaseModels === 'object');
});

test('setPhaseModelRef rejects an unknown phase or empty ref', async () => {
  await seedModels();
  const p = await makeProject('reject');
  assert.equal(await setPhaseModelRef(p.id, 'bogus-phase', 'provB/model-b'), null, 'unknown phase -> null');
  assert.equal(await setPhaseModelRef(p.id, 'rewrite-query', ''), null, 'empty ref -> null');
});

// ---------------------------------------------------------------------------
// 2. /model set-phase CLI
// ---------------------------------------------------------------------------

test('/model set-phase persists the phase model on the current project', async () => {
  await seedModels();
  const p = await makeProject('cli');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  const handled = await dispatchSlash('/model set-phase --phase=rewrite-query provB/model-b', ctx);
  assert.equal(handled, true, 'dispatchSlash handled the command');
  assert.ok(
    prints.some((s) => s.includes('Phase model set') && s.includes('rewrite-query') && s.includes('provB/model-b')),
    `expected a confirmation, got: ${JSON.stringify(prints)}`,
  );

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'rewrite-query'), 'provB/model-b', 'persisted on the project');

  // The session model itself must be untouched (only the phase override changes).
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model unchanged');
});

test('/model set-phase rejects an unknown phase', async () => {
  await seedModels();
  const p = await makeProject('badphase');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model set-phase --phase=bogus provB/model-b', ctx);
  assert.ok(prints.some((s) => s.includes('Unknown phase')), `expected unknown-phase error, got: ${JSON.stringify(prints)}`);
  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'bogus'), null, 'nothing persisted for bogus phase');
});

test('/model set-phase rejects a non-existent model ref', async () => {
  await seedModels();
  const p = await makeProject('badref');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model set-phase --phase=rewrite-query nope/missing', ctx);
  assert.ok(
    prints.some((s) => s.includes('Provider not found') || s.includes('Model not found')),
    `expected a not-found error, got: ${JSON.stringify(prints)}`,
  );
  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'rewrite-query'), null, 'nothing persisted for bad ref');
});

test('/model set-phase --clear removes the override', async () => {
  await seedModels();
  const p = await makeProject('clearcli');
  await setCurrentProject(p.id);
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');
  assert.equal(getPhaseModelRef(await getCurrentProject(), 'rewrite-query'), 'provB/model-b', 'precondition: override set');

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model set-phase --phase=rewrite-query --clear', ctx);
  assert.ok(
    prints.some((s) => s.includes('Cleared phase model') && s.includes('rewrite-query')),
    `expected a cleared confirmation, got: ${JSON.stringify(prints)}`,
  );
  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'rewrite-query'), null, 'override cleared');
});

test('phase model is per-project: project B is unaffected by project A', async () => {
  await seedModels();
  const a = await makeProject('projA');
  const b = await makeProject('projB');

  await setPhaseModelRef(a.id, 'rewrite-query', 'provB/model-b');
  const { getProject } = await import('../lib/config/home.js');
  assert.equal(getPhaseModelRef(await getProject(a.id), 'rewrite-query'), 'provB/model-b', 'precondition: A has the override');

  // Re-read each project directly: B must have no override.
  const reloadedA = await getProject(a.id);
  const reloadedB = await getProject(b.id);
  assert.equal(getPhaseModelRef(reloadedA, 'rewrite-query'), 'provB/model-b', 'A keeps its override');
  assert.equal(getPhaseModelRef(reloadedB, 'rewrite-query'), null, 'B unaffected');
});

// ---------------------------------------------------------------------------
// 3. Wiring: the rewrite phase resolves the configured model
// ---------------------------------------------------------------------------

test('runAgentTurn resolves a phase LLM for rewrite when the project has an override', async () => {
  await seedModels();
  const p = await makeProject('wire');
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  ctx.print = () => {};
  await reloadAll(session, ctx);

  // The session's active model is A (the default). The phase override is B.
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model is A');
  assert.equal(session.llm?.config?.apiKey, 'sk-a', 'session LLM uses provider A credentials');

  // Replicate the resolver logic runAgentTurn uses: when the project has a
  // rewrite-query override, resolveModelRef yields the phase model's config
  // (B's credentials), distinct from the session model.
  const { resolveModelRef } = await import('../lib/config/home.js');
  const { LLMClient } = await import('../lib/llm/client.js');
  const ref = getPhaseModelRef(session.project, 'rewrite-query');
  assert.equal(ref, 'provB/model-b', 'override visible on session.project');
  const phaseCfg = await resolveModelRef(ref);
  assert.ok(phaseCfg, 'phase model resolves to a config');
  const phaseLlm = new LLMClient(phaseCfg);
  assert.equal(phaseLlm.config?.apiKey, 'sk-b', 'phase LLM uses provider B credentials');
  assert.notEqual(phaseLlm.config?.apiKey, session.llm?.config?.apiKey, 'phase LLM differs from session LLM');
});
