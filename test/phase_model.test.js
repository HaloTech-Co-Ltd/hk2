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
import { runPhaseWithFallback, runPhaseWithSkipOnUnreachable, phaseModelFallbackEnabled } from '../src/phase_fallback.js';

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

// ---------------------------------------------------------------------------
// 4. /project show enumerates every supported phase (set + unset)
// ---------------------------------------------------------------------------
//
// Regression for the reported bug: `/project show` only listed the phases that
// had a SET override, so a project with no plan-review override printed
// nothing for plan-review. That read as "plan-review config is missing" even
// though the machinery was fine - it just falls back to the session model.
// showProject now iterates supportedPhaseNames() so every phase always
// appears, either with its ref or an explicit "(unset; uses the current
// session model)" marker.

test('/project show lists every supported phase even when unset', async () => {
  await seedModels();
  const p = await makeProject('showunset');
  // Only set rewrite-query; plan-review is left unset.
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/project show', ctx);
  const phaseLines = prints.filter((s) => /^\s+(rewrite-query|plan-review)\b/.test(s));
  assert.ok(phaseLines.length >= 2, `expected both phase rows, got: ${JSON.stringify(phaseLines)}`);
  assert.ok(
    phaseLines.some((s) => s.includes('rewrite-query') && s.includes('provB/model-b')),
    `rewrite-query shows its set ref: ${JSON.stringify(phaseLines)}`,
  );
  // plan-review was NOT set - it must still appear, marked as unset/fallback.
  const planReviewLine = phaseLines.find((s) => s.includes('plan-review'));
  assert.ok(planReviewLine, `plan-review row must always be present: ${JSON.stringify(phaseLines)}`);
  assert.ok(
    /unset|session model/i.test(planReviewLine),
    `unset plan-review marked as fallback: ${JSON.stringify(planReviewLine)}`,
  );
});

test('/project show shows both phases as set when both are configured', async () => {
  await seedModels();
  const p = await makeProject('showboth');
  await setPhaseModelRef(p.id, 'rewrite-query', 'provB/model-b');
  await setPhaseModelRef(p.id, 'plan-review', 'provB/model-b');

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/project show', ctx);
  const phaseLines = prints.filter((s) => /^\s+(rewrite-query|plan-review)\b/.test(s));
  assert.ok(
    phaseLines.some((s) => s.includes('rewrite-query') && s.includes('provB/model-b')),
    `rewrite-query row shows its ref: ${JSON.stringify(phaseLines)}`,
  );
  assert.ok(
    phaseLines.some((s) => s.includes('plan-review') && s.includes('provB/model-b')),
    `plan-review row shows its ref: ${JSON.stringify(phaseLines)}`,
  );
});

// ---------------------------------------------------------------------------
// 5. request-assess phase ('assessing request'): same mechanism as rewrite-query
// ---------------------------------------------------------------------------

test('normalizePhaseName maps request-assess to the requestAssess storage key', () => {
  assert.equal(normalizePhaseName('request-assess'), 'requestAssess');
  assert.equal(normalizePhaseName('Request-Assess'), 'requestAssess'); // case-insensitive
  assert.ok(supportedPhaseNames().includes('request-assess'), 'advertised in supportedPhaseNames');
});

test('setPhaseModelRef persists and getPhaseModelRef reads back request-assess', async () => {
  await seedModels();
  const p = await makeProject('assesssetget');
  assert.equal(getPhaseModelRef(p, 'request-assess'), null, 'no override before set');

  const updated = await setPhaseModelRef(p.id, 'request-assess', 'provB/model-b');
  assert.ok(updated, 'setPhaseModelRef returned the updated record');
  assert.equal(updated.phaseModels?.requestAssess, 'provB/model-b', 'stored under the storage key');
  assert.equal(getPhaseModelRef(updated, 'request-assess'), 'provB/model-b', 'read back via CLI name');

  // Read back directly by id (registerProject only claims `current` when it is
  // empty, so getCurrentProject() may point at an earlier project here).
  const { getProject } = await import('../lib/config/home.js');
  const reloaded = await getProject(p.id);
  assert.equal(getPhaseModelRef(reloaded, 'request-assess'), 'provB/model-b', 'persisted across reload');

  const cleared = await clearPhaseModelRef(p.id, 'request-assess');
  assert.equal(getPhaseModelRef(cleared, 'request-assess'), null, 'override removed');
  assert.ok(!('requestAssess' in (cleared.phaseModels || {})), 'key absent from phaseModels');
});

test('/model set-phase persists request-assess on the current project', async () => {
  await seedModels();
  const p = await makeProject('assesscli');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  const handled = await dispatchSlash('/model set-phase --phase=request-assess provB/model-b', ctx);
  assert.equal(handled, true, 'dispatchSlash handled the command');
  assert.ok(
    prints.some((s) => s.includes('Phase model set') && s.includes('request-assess') && s.includes('provB/model-b')),
    `expected a confirmation, got: ${JSON.stringify(prints)}`,
  );

  const reloaded = await getCurrentProject();
  assert.equal(getPhaseModelRef(reloaded, 'request-assess'), 'provB/model-b', 'persisted on the project');
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model unchanged');
});

test('runAgentTurn resolves a phase LLM for request-assess when the project has an override', async () => {
  await seedModels();
  const p = await makeProject('assesswire');
  await setPhaseModelRef(p.id, 'request-assess', 'provB/model-b');

  const session = createSession(p.id);
  const ctx = buildCtx(session);
  ctx.print = () => {};
  await reloadAll(session, ctx);

  // The session's active model is A (the default). The phase override is B.
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session model is A');
  assert.equal(session.llm?.config?.apiKey, 'sk-a', 'session LLM uses provider A credentials');

  // Replicate the resolver logic runAgentTurn uses for the assessment phase
  // ('assessing request'): resolvePhaseLlm('request-assess') -> B credentials.
  const { resolveModelRef } = await import('../lib/config/home.js');
  const { LLMClient } = await import('../lib/llm/client.js');
  const ref = getPhaseModelRef(session.project, 'request-assess');
  assert.equal(ref, 'provB/model-b', 'override visible on session.project');
  const phaseCfg = await resolveModelRef(ref);
  assert.ok(phaseCfg, 'phase model resolves to a config');
  const phaseLlm = new LLMClient(phaseCfg);
  assert.equal(phaseLlm.config?.apiKey, 'sk-b', 'phase LLM uses provider B credentials');
  assert.notEqual(phaseLlm.config?.apiKey, session.llm?.config?.apiKey, 'phase LLM differs from session LLM');
});

// ---------------------------------------------------------------------------
// 6. HK2_ENABLE_PHASEMODEL_FALLBACK policy (unreachable phase model)
// ---------------------------------------------------------------------------
//
// Regression for the reported bug: a phase model configured via
// /model set-phase but UNREACHABLE (connection refused / timeout / HTTP
// error) used to look like a successful phase — rewriteQuery swallowed the
// transport error and returned a fallback object, assessRequest returned
// { clear: true }, and no warning was ever printed.
//
// Policy (src/phase_fallback.js), driven by HK2_ENABLE_PHASEMODEL_FALLBACK
// (default 1):
//   1: warn, then re-run the phase on the session (main) model.
//   0: warn, then skip the phase entirely.
// Each phase (rewrite-query, request-assess) evaluates its OWN model.

// A fake LLM client whose stream throws (simulates an unreachable endpoint).
function deadLlm(reason = 'connect ECONNREFUSED') {
  const err = new Error(reason);
  return {
    config: { model: 'dead-model' },
    stream: async function* () { throw err; },
  };
}

// A fake LLM client whose stream succeeds; records which model ran.
function aliveLlm(tag, raw) {
  return {
    config: { model: tag },
    stream: async function* () {
      yield { type: 'delta', text: raw ?? JSON.stringify({ clear: true }) };
    },
  };
}

// run() stub mimicking rewriteQuery's contract: success returns a plain
// object, transport failure returns { ...result, error }.
function phaseRunStub() {
  const seen = [];
  return {
    seen,
    run: async (llm) => {
      seen.push(llm.config.model);
      // Simulate the rewrite_query contract: the LLM stream throws inside
      // callLlm, the phase fn catches and returns { ...fallback, error }.
      let out;
      try {
        for await (const evt of llm.stream([])) { /* drain */ }
        out = { ok: true, model: llm.config.model };
      } catch (err) {
        out = { ok: false, error: err.message };
      }
      return out;
    },
  };
}

test('phaseModelFallbackEnabled defaults to true and parses the env var', () => {
  const prev = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  try {
    delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    assert.equal(phaseModelFallbackEnabled(), true, 'default: fallback enabled');
    for (const v of ['1', 'yes', 'true', 'on', 'YES']) {
      process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = v;
      assert.equal(phaseModelFallbackEnabled(), true, `${v} -> true`);
    }
    for (const v of ['0', 'no', 'false', 'off', 'garbage']) {
      process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = v;
      assert.equal(phaseModelFallbackEnabled(), false, `${v} -> false`);
    }
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    else process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = prev;
  }
});

test('no phase model configured: pass-through on the session model, no warnings', async () => {
  const warns = [];
  const stub = phaseRunStub();
  const session = aliveLlm('session-model');
  const out = await runPhaseWithFallback({
    phase: 'rewrite-query',
    phaseLlm: null,
    sessionLlm: session,
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.deepEqual(stub.seen, ['session-model'], 'ran once, on the session model');
  assert.equal(out.skipped, false);
  assert.equal(out.usedFallback, false);
  assert.equal(out.error, null);
  assert.equal(warns.length, 0, "no override -> no policy, today's behavior");
  assert.equal(out.llm, session);
});

test('healthy phase model: runs on it once, no warnings, no fallback', async () => {
  const warns = [];
  const stub = phaseRunStub();
  const phase = aliveLlm('phase-model');
  const session = aliveLlm('session-model');
  const out = await runPhaseWithFallback({
    phase: 'rewrite-query',
    phaseLlm: phase,
    sessionLlm: session,
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.deepEqual(stub.seen, ['phase-model'], 'ran once, on the phase model');
  assert.equal(out.skipped, false);
  assert.equal(out.usedFallback, false);
  assert.equal(out.error, null);
  assert.equal(warns.length, 0);
  assert.equal(out.llm, phase);
});

test('unreachable phase model + FALLBACK=1 (default): warns then re-runs on the session model', async () => {
  const prev = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  const warns = [];
  const stub = phaseRunStub();
  try {
    const out = await runPhaseWithFallback({
      phase: 'rewrite-query',
      phaseLlm: deadLlm(),
      sessionLlm: aliveLlm('session-model'),
      warn: (m) => warns.push(m),
      run: stub.run,
    });
    assert.equal(out.skipped, false);
    assert.equal(out.usedFallback, true, 'degraded to the session model');
    assert.match(out.error, /ECONNREFUSED/, 'phase-model failure reason surfaced');
    assert.ok(out.result && out.result.ok, 'phase completed on the session model');
    assert.equal(out.result.model, 'session-model');
    assert.equal(out.llm.config.model, 'session-model', 'later passes reuse the session model');
    // Warning contract: unreachable -> warn; fallback decision -> warn.
    assert.ok(warns.some((m) => m.includes('unreachable') && m.includes('rewrite-query')), 'unreachable warning names the phase');
    assert.ok(warns.some((m) => m.includes('falling back to the session model')), 'fallback warning printed');
    assert.equal(warns.length, 2, 'exactly two warnings');
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    else process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = prev;
  }
});

test('unreachable phase model + FALLBACK=0: warns and skips the phase', async () => {
  const prev = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = '0';
  const warns = [];
  const stub = phaseRunStub();
  try {
    const out = await runPhaseWithFallback({
      phase: 'request-assess',
      phaseLlm: deadLlm(),
      sessionLlm: aliveLlm('session-model'),
      warn: (m) => warns.push(m),
      run: stub.run,
    });
    assert.equal(out.skipped, true, 'phase skipped entirely');
    assert.equal(out.result, null, 'no phase result');
    assert.equal(out.llm, null, 'nothing to reuse for later passes');
    assert.match(out.error, /ECONNREFUSED/);
    assert.deepEqual(stub.seen, ['dead-model'], 'session model never invoked');
    assert.ok(warns.some((m) => m.includes('unreachable') && m.includes('request-assess')));
    assert.ok(warns.some((m) => m.includes('skipping the request-assess phase') && m.includes('HK2_ENABLE_PHASEMODEL_FALLBACK=0')));
    assert.equal(warns.length, 2);
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    else process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = prev;
  }
});

test('unreachable phase model + FALLBACK=1 + session model also fails: second warning, never silent', async () => {
  const prev = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  const warns = [];
  const stub = phaseRunStub();
  try {
    const out = await runPhaseWithFallback({
      phase: 'rewrite-query',
      phaseLlm: deadLlm('phase endpoint down'),
      sessionLlm: deadLlm('session endpoint down'),
      warn: (m) => warns.push(m),
      run: stub.run,
    });
    assert.equal(out.skipped, false);
    assert.equal(out.usedFallback, true);
    assert.ok(out.result && out.result.error, 'degraded fallback result (historic behavior)');
    assert.ok(warns.some((m) => m.includes('unreachable')));
    assert.ok(warns.some((m) => m.includes('falling back to the session model')));
    assert.ok(warns.some((m) => m.includes('session model also failed')), 'double failure is warned, not silent');
    assert.equal(warns.length, 3);
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    else process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = prev;
  }
});

test('result-object error (thrown contract) is treated as a transport failure too', async () => {
  // Defensive: a phase fn that THROWS instead of returning { error } must not
  // bypass the policy.
  const warns = [];
  let calls = 0;
  const out = await runPhaseWithFallback({
    phase: 'rewrite-query',
    phaseLlm: { config: { model: 'phase-model' } },
    sessionLlm: aliveLlm('session-model'),
    warn: (m) => warns.push(m),
    run: async (llm) => {
      calls++;
      if (llm.config.model === 'phase-model') throw new Error('connect timeout');
      return { ok: true, model: llm.config.model };
    },
  });
  assert.equal(calls, 2, 'phase model failed, session model retried');
  assert.equal(out.usedFallback, true);
  assert.equal(out.result.model, 'session-model');
  assert.ok(warns.some((m) => m.includes('unreachable')));
});

test('each phase evaluates its own model: rewrite dead + assess alive are independent', async () => {
  // The two phases may be pinned to DIFFERENT providers; one dying must not
  // affect the other. runAgentTurn calls runPhaseWithFallback separately per
  // phase, so this locks in the wiring contract.
  const warns = [];

  const rewriteRun = await runPhaseWithFallback({
    phase: 'rewrite-query',
    phaseLlm: deadLlm('rewrite endpoint down'),
    sessionLlm: aliveLlm('session-model'),
    warn: (m) => warns.push(m),
    run: async (llm) => {
      try {
        for await (const evt of llm.stream([])) { /* drain */ }
        return { ok: true, model: llm.config.model };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  });
  assert.equal(rewriteRun.usedFallback, true, 'rewrite fell back to the session model');

  const assessRun = await runPhaseWithFallback({
    phase: 'request-assess',
    phaseLlm: aliveLlm('assess-model'),
    sessionLlm: aliveLlm('session-model'),
    warn: (m) => warns.push(m),
    run: async (llm) => {
      try {
        for await (const evt of llm.stream([])) { /* drain */ }
        return { ok: true, model: llm.config.model };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  });
  assert.equal(assessRun.usedFallback, false, 'healthy assess phase model still used');
  assert.equal(assessRun.llm.config.model, 'assess-model');
  assert.equal(assessRun.error, null);
  assert.ok(!warns.some((m) => m.includes('request-assess')), 'no assess-phase warning');
});

// ---------------------------------------------------------------------------
// 7. Review phases (plan-review / code-review): SKIP on unreachable
// ---------------------------------------------------------------------------
//
// Review phases are quality gates, so they use a different policy than
// rewrite-query / request-assess: when the model that would run the review
// (the configured phase model, or the session model when no override exists)
// is unreachable, print warnings and SKIP the phase — NEVER silently re-run it
// on another model (that would change what the user believes reviewed their
// plan/code). HK2_ENABLE_PHASEMODEL_FALLBACK does not apply here.

test('review policy: healthy phase model runs once, no warnings, no skip', async () => {
  const warns = [];
  const stub = phaseRunStub();
  const phase = aliveLlm('review-model');
  const session = aliveLlm('session-model');
  const out = await runPhaseWithSkipOnUnreachable({
    phase: 'plan-review',
    phaseLlm: phase,
    sessionLlm: session,
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.deepEqual(stub.seen, ['review-model'], 'ran once, on the review model');
  assert.equal(out.skipped, false);
  assert.equal(out.usedFallback, false);
  assert.equal(out.error, null);
  assert.equal(warns.length, 0);
  assert.equal(out.llm, phase);
});

test('review policy: unreachable phase model warns and skips (never falls back)', async () => {
  const warns = [];
  const stub = phaseRunStub();
  const session = aliveLlm('session-model');
  const out = await runPhaseWithSkipOnUnreachable({
    phase: 'plan-review',
    phaseLlm: deadLlm(),
    sessionLlm: session,
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.equal(out.skipped, true, 'review skipped entirely');
  assert.equal(out.result, null);
  assert.equal(out.llm, null);
  assert.match(out.error, /ECONNREFUSED/);
  assert.deepEqual(stub.seen, ['dead-model'], 'session model NEVER invoked — no fallback');
  assert.ok(warns.some((m) => m.includes('unreachable') && m.includes('plan-review')), 'unreachable warning names the phase');
  assert.ok(warns.some((m) => m.includes('skipping the plan-review phase')), 'skip warning printed');
  assert.equal(warns.length, 2, 'exactly two warnings');
});

test('review policy ignores HK2_ENABLE_PHASEMODEL_FALLBACK (=1 still skips, no fallback)', async () => {
  const prev = process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
  process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = '1';
  const warns = [];
  const stub = phaseRunStub();
  try {
    const out = await runPhaseWithSkipOnUnreachable({
      phase: 'code-review',
      phaseLlm: deadLlm('review endpoint down'),
      sessionLlm: aliveLlm('session-model'),
      warn: (m) => warns.push(m),
      run: stub.run,
    });
    assert.equal(out.skipped, true, 'even with FALLBACK=1 the review is skipped, not re-run');
    assert.equal(out.usedFallback, false);
    assert.deepEqual(stub.seen, ['dead-model'], 'session model never invoked');
    assert.equal(warns.length, 2);
  } finally {
    if (prev === undefined) delete process.env.HK2_ENABLE_PHASEMODEL_FALLBACK;
    else process.env.HK2_ENABLE_PHASEMODEL_FALLBACK = prev;
  }
});

test('review policy: no phase model configured runs on the session model', async () => {
  const warns = [];
  const stub = phaseRunStub();
  const session = aliveLlm('session-model');
  const out = await runPhaseWithSkipOnUnreachable({
    phase: 'code-review',
    phaseLlm: null,
    sessionLlm: session,
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.deepEqual(stub.seen, ['session-model'], 'ran once, on the session model');
  assert.equal(out.skipped, false);
  assert.equal(out.usedFallback, false);
  assert.equal(warns.length, 0);
  assert.equal(out.llm, session);
});

test('review policy: no phase model + dead session model also warns and skips', async () => {
  // A dead session model with no override must not degrade to a silent
  // "no issues found" — the same never-silent contract applies.
  const warns = [];
  const stub = phaseRunStub();
  const out = await runPhaseWithSkipOnUnreachable({
    phase: 'code-review',
    phaseLlm: null,
    sessionLlm: deadLlm('session endpoint down'),
    warn: (m) => warns.push(m),
    run: stub.run,
  });
  assert.equal(out.skipped, true);
  assert.equal(out.result, null);
  assert.match(out.error, /session endpoint down/);
  assert.ok(warns.some((m) => m.includes('session model for code-review is unreachable')), 'warning names the session model');
  assert.ok(warns.some((m) => m.includes('skipping the code-review phase')));
  assert.equal(warns.length, 2);
});

test('review policy: thrown contract (run throws) is treated as unreachable too', async () => {
  const warns = [];
  const out = await runPhaseWithSkipOnUnreachable({
    phase: 'plan-review',
    phaseLlm: { config: { model: 'review-model' } },
    sessionLlm: aliveLlm('session-model'),
    warn: (m) => warns.push(m),
    run: async () => { throw new Error('connect timeout'); },
  });
  assert.equal(out.skipped, true);
  assert.match(out.error, /connect timeout/);
  assert.equal(warns.length, 2);
});
