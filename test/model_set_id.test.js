/*-------------------------------------------------------------------------
 *
 * /model set --id regression tests.
 *
 * `/model set <provider>/<old-id> --id=<new-id>` renames a persisted model's
 * id (the provider/accounting key used in provider/id refs). Key contracts:
 *
 *   1. The id is renamed and the old id disappears; the global default ref is
 *      rewired when it pointed at the old ref.
 *   2. `name` (the WIRE model code sent to the API) is preserved: an explicit
 *      name stays, and a legacy record with NO name gets `name` pinned to the
 *      OLD id so the rename cannot change what is sent to the API.
 *   3. Per-project phase-model overrides are rewired on rename (persisted AND
 *      the in-session copy via noteReloadProject).
 *   4. A colliding id, an empty id, and an id containing '/' are rejected
 *      before any write.
 *   5. When the session is using the renamed model, it hot-swaps to the new
 *      ref (modelCfg + sessionModelRef + a rebuilt LLMClient).
 *   6. No command may fail silently: any "Error:" print fails the test.
 *
 * Run:  node --test test/model_set_id.test.js
 *-----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels,
  loadProjects, saveProjects, resolveModelRef,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

function makeCtx() {
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);
  return { session, ctx, prints };
}

// dispatchSlash catches handler errors and prints "Error: ...". A regression
// that throws mid-way can still persist state BEFORE the throw and pass a
// naive state assertion - so every happy-path test also asserts no error was
// printed.
function assertNoError(prints, label) {
  const err = prints.find((p) => typeof p === 'string' && p.startsWith('Error:'));
  assert.ok(!err, `${label}: command failed silently: ${err || '(none)'}`);
}

async function seedModels() {
  await ensureHome();
  await saveModels({
    providers: {
      prov: {
        api: 'openai',
        baseUrl: 'http://x/v1',
        apiKey: 'sk-x',
        models: [{ id: 'model', name: 'model', contextWindow: 8192, temperature: 0.2, modelType: 'generic' }],
      },
    },
    default: 'prov/model',
  });
}

test('/model set --id renames the id, keeps name, and rewires the default', async () => {
  await seedModels();
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model set prov/model --id=renamed', ctx);
  assertNoError(prints, 'rename');

  const { providers, default: def } = await loadModels();
  const models = providers.prov.models;
  assert.ok(models.find((m) => m.id === 'renamed'), 'id renamed');
  assert.ok(!models.find((m) => m.id === 'model'), 'old id gone');
  assert.equal(models.find((m) => m.id === 'renamed').name, 'model', 'name (wire code) untouched');
  assert.equal(def, 'prov/renamed', 'default ref rewired');
  assert.ok(prints.some((p) => p.includes('Updated: prov/renamed')), 'confirms new ref');
});

test('/model set --id pins name to the OLD id for legacy records (wire code unchanged)', async () => {
  await ensureHome();
  // Legacy record: no `name` field at all. resolveModelRef falls back to `id`
  // as the wire code, so a rename must pin `name` to the old id or the API
  // request body would silently start sending the NEW id.
  await saveModels({
    providers: {
      leg: {
        api: 'openai', baseUrl: '', apiKey: 'k',
        models: [{ id: 'glm-5.2', contextWindow: 65536, temperature: 0.2 }],
      },
    },
    default: 'leg/glm-5.2',
  });
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model set leg/glm-5.2 --id=glm-5.2[1m]', ctx);
  assertNoError(prints, 'legacy rename');

  // The wire code resolves to the OLD id, NOT the new bracketed ref.
  const cfg = await resolveModelRef('leg/glm-5.2[1m]');
  assert.ok(cfg, 'new ref resolves');
  assert.equal(cfg.model, 'glm-5.2', 'wire model code is pinned to the old id, not the new one');
  assert.equal(cfg.ref, 'leg/glm-5.2[1m]', 'ref uses the new id');
});

test('/model set --id with an explicit --name still sets the name (rename + rename of wire code)', async () => {
  await seedModels();
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model set prov/model --id=renamed --name=wire-code', ctx);
  assertNoError(prints, 'rename + name');

  const { providers } = await loadModels();
  const m = providers.prov.models.find((x) => x.id === 'renamed');
  assert.equal(m.name, 'wire-code', 'explicit --name wins over the pinned old id');
});

test('/model set --id rewires per-project phase model overrides (and flags a project reload)', async () => {
  await seedModels();
  await saveProjects({
    current: 'p1',
    projects: {
      p1: { id: 'p1', name: 'p1', sourcePath: '/tmp/p1', phaseModels: { rewriteQuery: 'prov/model' } },
      p2: { id: 'p2', name: 'p2', sourcePath: '/tmp/p2', phaseModels: { rewriteQuery: 'other/model' } },
    },
  });
  const { session, ctx, prints } = makeCtx();
  await reloadAll(session, ctx);   // loads project p1 into the session
  assert.equal(session.project?.phaseModels?.rewriteQuery, 'prov/model', 'session sees the old ref');

  await dispatchSlash('/model set prov/model --id=renamed', ctx);
  assertNoError(prints, 'rename with phase refs');

  // Persisted refs are rewired...
  const { projects } = await loadProjects();
  assert.equal(projects.p1.phaseModels.rewriteQuery, 'prov/renamed', 'matching phase ref rewired');
  assert.equal(projects.p2.phaseModels.rewriteQuery, 'other/model', 'unrelated phase ref left alone');
  // ...and the session is told to refresh its in-memory project copy.
  assert.equal(session.reloadFlags.project, true, 'noteReloadProject signaled');

  // After the reload actually runs, the phase override resolves to the new ref.
  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };
  assert.equal(session.project?.phaseModels?.rewriteQuery, 'prov/renamed', 'in-memory copy refreshed');
});

test('/model set --id rejects a colliding id', async () => {
  await saveModels({
    providers: {
      prov: {
        api: 'openai', baseUrl: '', apiKey: '',
        models: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
      },
    },
    default: 'prov/a',
  });
  const { ctx, prints } = makeCtx();

  await dispatchSlash('/model set prov/a --id=b', ctx);

  const { providers, default: def } = await loadModels();
  assert.ok(providers.prov.models.find((m) => m.id === 'a'), 'a unchanged');
  assert.ok(providers.prov.models.find((m) => m.id === 'b'), 'b unchanged');
  assert.equal(def, 'prov/a', 'default unchanged');
  assert.ok(prints.some((p) => p.includes('Model already exists: prov/b')), 'prints collision');
});

test('/model set --id rejects an empty or slash-containing id', async () => {
  await seedModels();

  const { ctx, prints } = makeCtx();
  await dispatchSlash('/model set prov/model --id=', ctx);
  await dispatchSlash('/model set prov/model --id=bad/id', ctx);

  const { providers } = await loadModels();
  assert.ok(providers.prov.models.find((m) => m.id === 'model'), 'id unchanged after invalid --id');
  assert.ok(prints.some((p) => p.includes('Invalid --id: expected')), 'empty --id rejected');
  assert.ok(prints.some((p) => p.includes('Invalid --id: bad/id')), 'slash --id rejected');
});

test('/model set --id hot-swaps the session model to the new ref', async () => {
  await seedModels();
  const { session, ctx, prints } = makeCtx();
  await reloadAll(session, ctx);
  assert.equal(session.modelCfg?.ref, 'prov/model', 'session starts on the model being renamed');

  await dispatchSlash('/model set prov/model --id=renamed', ctx);
  assertNoError(prints, 'rename hot-swap');

  assert.equal(session.modelCfg?.ref, 'prov/renamed', 'modelCfg on the new ref');
  assert.equal(session.sessionModelRef, 'prov/renamed', 'sessionModelRef follows the rename');
  assert.equal(session.llm?.config?.model, 'model', 'LLMClient rebuilt; wire code still the pinned name');
  assert.equal(session.llm?.config?.apiKey, 'sk-x', 'credentials carried over');
});
