/*-------------------------------------------------------------------------
 *
 * Per-project default model tests.
 *
 * `/model set-default current <provider>/<model-id>` sets the CURRENT
 * project's default model (stored as `defaultModel` in projects.json). When
 * set, the project resolves its default model from the override; when unset
 * (or cleared), it falls back to the global default in models.json.
 *
 * Precedence (highest first):
 *   1. session-only override (/model use -> session.sessionModelRef)
 *   2. current project's defaultModel override
 *   3. global models.json default
 *
 * These tests lock in:
 *   1. config helpers getProjectDefaultModelRef / setProjectDefaultModelRef /
 *      clearProjectDefaultModelRef.
 *   2. resolveDefaultModel prefers the project override and falls back to the
 *      global default when the override is unset OR stale (unresolvable).
 *   3. the CLI subcommand persists, rejects bad refs, supports --clear, and is
 *      per-project (switching the current project changes the effective
 *      default; project B's override doesn't leak into project A).
 *   4. /model set --id rename rewires project defaultModel refs.
 *   5. /model del cleans up project defaultModel refs.
 *
 * Run:  node --test test/project_default_model.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ensureHome, loadModels, saveModels, loadProjects,
  registerProject, setCurrentProject, getCurrentProject,
  getProjectDefaultModelRef, setProjectDefaultModelRef, clearProjectDefaultModelRef,
  resolveDefaultModel, resolveModelRef,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

let __seq = 0;
async function makeSourceDir(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hk2-pdm-${name}-`));
}

// Seed models.json with two providers/models and a global default of A.
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

function makeCtx(session, prints = []) {
  const ctx = buildCtx(session);
  ctx.print = (t) => prints.push(t);
  return ctx;
}

// ---------------------------------------------------------------------------
// 1. Config helpers
// ---------------------------------------------------------------------------

test('setProjectDefaultModelRef persists and getProjectDefaultModelRef reads it back', async () => {
  await seedModels();
  const p = await makeProject('setget');
  assert.equal(getProjectDefaultModelRef(p), null, 'no override before set');

  const updated = await setProjectDefaultModelRef(p.id, 'provB/model-b');
  assert.ok(updated, 'setProjectDefaultModelRef returned the updated record');
  assert.equal(updated.defaultModel, 'provB/model-b', 'stored as defaultModel');
  assert.equal(getProjectDefaultModelRef(updated), 'provB/model-b', 'read back');

  // Reload from disk to prove it persisted.
  const reloaded = await getCurrentProject();
  assert.equal(getProjectDefaultModelRef(reloaded), 'provB/model-b', 'persisted across reload');
});

test('clearProjectDefaultModelRef removes the override (no-op when unset)', async () => {
  await seedModels();
  const p = await makeProject('clear');
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const cleared = await clearProjectDefaultModelRef(p.id);
  assert.ok(cleared, 'clear returned the updated record');
  assert.equal(getProjectDefaultModelRef(cleared), null, 'override removed');

  // Clearing again is a no-op that still returns the record.
  const again = await clearProjectDefaultModelRef(p.id);
  assert.ok(again, 'second clear still returns the record');
  assert.equal(getProjectDefaultModelRef(again), null);

  assert.equal(await setProjectDefaultModelRef(p.id, ''), null, 'empty ref rejected');
  assert.equal(await clearProjectDefaultModelRef('no-such-id'), null, 'unknown project rejected');
});

// ---------------------------------------------------------------------------
// 2. resolveDefaultModel precedence
// ---------------------------------------------------------------------------

test('resolveDefaultModel prefers the project override over the global default', async () => {
  await seedModels();
  const p = await makeProject('pref');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const cfg = await resolveDefaultModel();
  assert.ok(cfg, 'resolved');
  assert.equal(cfg.ref, 'provB/model-b', 'project override wins');
  assert.equal(cfg.baseUrl, 'http://b.example/v1', 'resolved from provB');
});

test('resolveDefaultModel falls back to the global default when no override is set', async () => {
  await seedModels();
  const p = await makeProject('nopl');
  await setCurrentProject(p.id);

  const cfg = await resolveDefaultModel();
  assert.ok(cfg, 'resolved');
  assert.equal(cfg.ref, 'provA/model-a', 'global default used');
});

test('resolveDefaultModel falls back to the global default when the override is stale', async () => {
  await seedModels();
  const p = await makeProject('stale');
  await setCurrentProject(p.id);
  // Point the override at a model that does not exist.
  await setProjectDefaultModelRef(p.id, 'provB/no-such-model');

  const cfg = await resolveDefaultModel();
  assert.ok(cfg, 'resolved');
  assert.equal(cfg.ref, 'provA/model-a', 'stale override skipped, global default used');
});

// ---------------------------------------------------------------------------
// 3. CLI: /model set-default current
// ---------------------------------------------------------------------------

test('/model set-default current persists the project default and hot-swaps the session', async () => {
  await seedModels();
  const p = await makeProject('cli');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  await reloadAll(session, ctx);
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session starts on the global default');

  const handled = await dispatchSlash('/model set-default current provB/model-b', ctx);
  assert.equal(handled, true);

  // Persisted on the project, global default untouched.
  const reloaded = await getCurrentProject();
  assert.equal(getProjectDefaultModelRef(reloaded), 'provB/model-b', 'persisted on the project');
  const persistedModels = await loadModels();
  assert.equal(persistedModels.default, 'provA/model-a', 'global default untouched');
  // NOT recorded as a session-only override (that would outlive the project
  // switch / clear); the effective default arrives via the flagged reload.
  assert.equal(session.sessionModelRef, null, 'not recorded as a session-only override');

  // The reload flags were signaled so reloadAll re-resolves consistently.
  assert.equal(session.reloadFlags.model, true, 'model reload signaled');
  assert.equal(session.reloadFlags.project, true, 'project reload signaled');
  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'reload applies the project default');
});

test('/model set-default current --clear removes the override', async () => {
  await seedModels();
  const p = await makeProject('cliclear');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  const handled = await dispatchSlash('/model set-default current --clear', ctx);
  assert.equal(handled, true);
  const reloaded = await getCurrentProject();
  assert.equal(getProjectDefaultModelRef(reloaded), null, 'override cleared');

  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'back on the global default');
});

test('/model set-default current rejects bad refs and unknown projects', async () => {
  await seedModels();
  const p = await makeProject('badref');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  // Bad refs: invalid shape, unknown provider, unknown model.
  for (const bad of ['nonsense', 'provX/model-x', 'provA/model-x']) {
    const session = createSession(p.id);
    const ctx = makeCtx(session);
    const prints = [];
    ctx.print = (t) => prints.push(t);
    await dispatchSlash(`/model set-default current ${bad}`, ctx);
    const reloaded = await getCurrentProject();
    assert.equal(getProjectDefaultModelRef(reloaded), 'provB/model-b', `override untouched for ${bad}`);
    assert.ok(prints.length > 0, `error printed for ${bad}`);
  }

  // No current project: the command must refuse.
  const data = await loadProjects();
  data.current = null;
  const { saveProjects } = await import('../lib/config/home.js');
  await saveProjects(data);
  const session = createSession(null);
  const ctx = makeCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);
  await dispatchSlash('/model set-default current provB/model-b', ctx);
  assert.ok(prints.some((s) => s.includes('No current project')), 'no-project error printed');
});

test('project overrides are isolated per project', async () => {
  await seedModels();
  const a = await makeProject('isoA');
  const b = await makeProject('isoB');
  await setProjectDefaultModelRef(a.id, 'provB/model-b');
  await setCurrentProject(b.id);

  // Project B has no override -> global default.
  let cfg = await resolveDefaultModel();
  assert.equal(cfg.ref, 'provA/model-a', 'project B uses the global default');

  // Switch to project A -> its override applies.
  await setCurrentProject(a.id);
  cfg = await resolveDefaultModel();
  assert.equal(cfg.ref, 'provB/model-b', 'project A override applies after the switch');

  // B's record is untouched.
  const rb = (await loadProjects()).projects[b.id];
  assert.equal(getProjectDefaultModelRef(rb), null, 'project B has no override');
});

test('session-only /model use override still wins over the project default', async () => {
  await seedModels();
  const p = await makeProject('usewins');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  await reloadAll(session, ctx);
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'starts on the project default');

  // Session-only choice overrides everything for this session.
  await dispatchSlash('/model use provA/model-a', ctx);
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session override applied');

  // Setting the project default mid-session must NOT drag the session along.
  await dispatchSlash('/model set-default current provB/model-b', ctx);
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'session-only override keeps winning');

  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'override survives the reload');
});

// ---------------------------------------------------------------------------
// 4. Rename / delete consistency
// ---------------------------------------------------------------------------

test('/model set --id renames the ref and rewires project defaultModel refs', async () => {
  await seedModels();
  const p = await makeProject('rename');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  await reloadAll(session, ctx);

  await dispatchSlash('/model set provB/model-b --id=model-b2', ctx);

  const reloaded = await getCurrentProject();
  assert.equal(getProjectDefaultModelRef(reloaded), 'provB/model-b2', 'project default rewired to the new ref');
  const cfg = await resolveDefaultModel();
  assert.equal(cfg.ref, 'provB/model-b2', 'resolves via the new ref');
});

test('/model del cleans up project defaultModel refs', async () => {
  await seedModels();
  const p = await makeProject('delclean');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  await reloadAll(session, ctx);

  await dispatchSlash('/model del provB/model-b', ctx);

  const reloaded = await getCurrentProject();
  assert.equal(getProjectDefaultModelRef(reloaded), null, 'stale ref removed');
  const cfg = await resolveDefaultModel();
  assert.equal(cfg.ref, 'provA/model-a', 'falls back to the global default');
});

// ---------------------------------------------------------------------------
// 5. Display
// ---------------------------------------------------------------------------

test('/model show reports the project default alongside the global default', async () => {
  await seedModels();
  const p = await makeProject('show');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model show', ctx);
  const out = prints.join('\n');
  assert.ok(out.includes('default = provB/model-b'), 'effective default is the project override');
  assert.ok(out.includes('project default, set via /model set-default current'), 'project line shown');
  assert.ok(out.includes('global: provA/model-a'), 'global default still shown');
});

test('/project show displays defaultModel (or the fallback)', async () => {
  await seedModels();
  const p = await makeProject('pshow');
  await setCurrentProject(p.id);

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  let prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/project show', ctx);
  assert.ok(prints.some((s) => s.includes('defaultModel: (unset; uses the global default: provA/model-a)')),
    'unset override shows the global fallback');

  await setProjectDefaultModelRef(p.id, 'provB/model-b');
  prints = [];
  await dispatchSlash('/project show', ctx);
  assert.ok(prints.some((s) => s.includes('defaultModel: provB/model-b')), 'set override displayed');
});

test('/model list marks the project default', async () => {
  await seedModels();
  const p = await makeProject('listmark');
  await setCurrentProject(p.id);
  await setProjectDefaultModelRef(p.id, 'provB/model-b');

  const session = createSession(p.id);
  const ctx = makeCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  await reloadAll(session, ctx);

  await dispatchSlash('/model list', ctx);
  const out = prints.join('\n');
  assert.ok(out.includes('project default: provB/model-b'), 'header shows the project default');
  // provB row is marked with '+' and NOT '*' (the global default marker).
  // Model rows start with the 2-char marker ('* ', '+ ', ' +', ...); find the
  // provB row among rows that are NOT the header and NOT the detail line.
  const provBRow = prints.find((s) => /^[*+ ]{1,2}\s*model-b(\s|$)/.test(s));
  assert.ok(provBRow, 'provB row found');
  assert.ok(provBRow.includes('+'), `provB row marked with +: ${JSON.stringify(provBRow)}`);
  assert.ok(!provBRow.startsWith('*'), 'provB is not the global default');
})
