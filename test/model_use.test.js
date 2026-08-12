/*-------------------------------------------------------------------------
 *
 * /model use regression tests.
 *
 * `/model use <provider>/<model-id>` hot-swaps the active model for the
 * current REPL session only (not persisted to models.json). These tests
 * lock in the three guarantees that make "switch the current session's
 * model" actually take effect:
 *
 *   1. After `/model use`, session.modelCfg / session.llm / session.sessionModelRef
 *      all reflect the newly chosen model (the agent loop reads session.llm).
 *   2. The override survives a models.json reload (noteReloadModels ->
 *      reloadAll re-resolves sessionModelRef instead of resolveDefaultModel),
 *      so a subsequent /model set-default must NOT clobber the session choice.
 *   3. /model set-default persists the global default without touching the
 *      session override.
 *
 * Run:  node --test test/model_use.test.js
 *----------------------------------------------------------------------*/

// MUST be first: isolate HK2_HOME before any module reads it.
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import {
  ensureHome, loadModels, saveModels,
} from '../lib/config/home.js';
import { createSession, buildCtx, reloadAll } from '../src/commands/interactive.js';
import { dispatchSlash } from '../src/slash/index.js';

// Seed models.json with two providers/models and a default, in the isolated
// HK2_HOME. Returns nothing; tests re-read state via the session.
async function seedModels() {
  await ensureHome();
  const data = {
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
  };
  await saveModels(data);
}

test('/model use hot-swaps the active session model (modelCfg + llm + sessionModelRef)', async () => {
  await seedModels();
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);

  await reloadAll(session, ctx);
  assert.equal(session.modelCfg?.ref, 'provA/model-a', 'default model resolved on startup');
  assert.equal(session.llm?.config?.model, 'model-a', 'LLMClient built from the default');

  // `/model use provB/model-b` -> session-only switch.
  const handled = await dispatchSlash('/model use provB/model-b', ctx);
  assert.equal(handled, true, 'dispatchSlash handled the slash command');
  assert.ok(
    prints.some((p) => p.includes('Session model: provB/model-b') && p.includes('session only')),
    `expected session-only confirmation, got: ${JSON.stringify(prints)}`,
  );

  assert.equal(session.sessionModelRef, 'provB/model-b', 'sessionModelRef records the override');
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'modelCfg switched to B');
  assert.equal(session.llm?.config?.model, 'model-b', 'a NEW LLMClient was built for B');
  assert.equal(session.llm?.config?.apiKey, 'sk-b', 'new client uses provider B credentials');

  // The persisted default must be untouched.
  const persisted = await loadModels();
  assert.equal(persisted.default, 'provA/model-a', '/model use must NOT persist to models.json');
});

test('a /model use override survives a models.json reload (noteReloadModels)', async () => {
  await seedModels();
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);

  await reloadAll(session, ctx);
  await dispatchSlash('/model use provB/model-b', ctx);
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'override applied');

  // Simulate the enqueue loop: a slash command set reloadFlags.model=true
  // (e.g. /model set-default) and reloadAll runs with flags.model=true.
  // The session override must win over the persisted default.
  session.reloadFlags.model = true;
  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };

  assert.equal(session.sessionModelRef, 'provB/model-b', 'override retained');
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'reload re-resolved the OVERRIDE, not the default');
  assert.equal(session.llm?.config?.model, 'model-b', 'LLMClient still on B after reload');
});

test('/model set-default persists the global default without clobbering the session override', async () => {
  await seedModels();
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);

  await reloadAll(session, ctx);
  await dispatchSlash('/model use provB/model-b', ctx);

  // Change the global default to B via set-default. This calls
  // noteReloadModels() -> reloadFlags.model=true. reloadAll must keep the
  // session on B (its override) - the user explicitly chose it for this session.
  await dispatchSlash('/model set-default provB/model-b', ctx);
  assert.equal(session.reloadFlags.model, true, 'set-default signals a model reload');

  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };

  // Persisted default is now B...
  const persisted = await loadModels();
  assert.equal(persisted.default, 'provB/model-b', 'global default persisted as B');
  // ...and the session is still on B via its override (not reset to default).
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'session stays on B');
  assert.equal(session.sessionModelRef, 'provB/model-b', 'override intact');
});

test('switching the global default away from the session model does not drag the session along', async () => {
  await seedModels();
  const session = createSession(null);
  const ctx = buildCtx(session);
  const prints = [];
  ctx.print = (t) => prints.push(t);

  await reloadAll(session, ctx);
  // Session pinned to B; global default stays A.
  await dispatchSlash('/model use provB/model-b', ctx);

  // Now flip the global default back to A (persisted). The session must stay
  // on B because sessionModelRef overrides the default on every reload.
  await dispatchSlash('/model set-default provA/model-a', ctx);
  await reloadAll(session, ctx, session.reloadFlags);
  session.reloadFlags = { project: false, kb: false, model: false };

  const persisted = await loadModels();
  assert.equal(persisted.default, 'provA/model-a', 'global default is A');
  assert.equal(session.modelCfg?.ref, 'provB/model-b', 'session override (B) survives');
  assert.equal(session.llm?.config?.model, 'model-b', 'active client is still B');
});

// Regression for the reported bug: `/model use` between two providers that
// host the SAME model id (e.g. volcengine/glm-5.2[1m] vs volcengine2/glm-5.2[1m])
// looked like it "didn't take effect" because the prompt / status bar / welcome
// card rendered only the model-id segment (ref.split('/').pop()), which is
// identical for both. The display now keeps the provider so the switch is
// visible. We assert the observable contract: after each switch the full ref
// differs, and the display tag (full ref minus a trailing [ctx] hint) differs.
test('/model use between two providers sharing a model id is visible in the display', async () => {
  await ensureHome();
  // Two providers, same model id, like the user's volcengine / volcengine2.
  await saveModels({
    providers: {
      alpha: {
        api: 'openai', baseUrl: 'http://alpha/v1', apiKey: 'sk-a',
        models: [{ id: 'shared-model[1m]', name: 'Shared', contextWindow: 1000000, temperature: 0.2 }],
      },
      beta: {
        api: 'openai', baseUrl: 'http://beta/v1', apiKey: 'sk-b',
        models: [{ id: 'shared-model[1m]', name: 'Shared', contextWindow: 1000000, temperature: 0.2 }],
      },
    },
    default: 'alpha/shared-model[1m]',
  });

  const session = createSession(null);
  const ctx = buildCtx(session);
  ctx.print = () => {};
  await reloadAll(session, ctx);

  // Display tag = full ref with a trailing bracketed hint stripped, matching
  // modelTagFor() in interactive.js.
  const displayTag = (s) => (s.modelCfg?.ref || '').replace(/\s*\[[^\]]*\]\s*$/, '');

  assert.equal(session.modelCfg.ref, 'alpha/shared-model[1m]', 'starts on alpha');
  const tagAlpha = displayTag(session);

  await dispatchSlash('/model use beta/shared-model[1m]', ctx);
  assert.equal(session.modelCfg.ref, 'beta/shared-model[1m]', 'switched to beta');
  assert.equal(session.llm.config.apiKey, 'sk-b', 'active client now uses beta credentials');
  const tagBeta = displayTag(session);

  await dispatchSlash('/model use alpha/shared-model[1m]', ctx);
  assert.equal(session.modelCfg.ref, 'alpha/shared-model[1m]', 'switched back to alpha');
  const tagAlphaAgain = displayTag(session);

  // The whole point: the two providers must NOT render identically.
  assert.notEqual(tagAlpha, tagBeta,
    `display must distinguish the two providers (got "${tagAlpha}" == "${tagBeta}")`);
  assert.equal(tagAlpha, tagAlphaAgain, 'switching back restores the alpha tag');
  assert.ok(tagAlpha.startsWith('alpha/'), 'alpha tag keeps the provider prefix');
  assert.ok(tagBeta.startsWith('beta/'), 'beta tag keeps the provider prefix');
  // The [1m] hint is stripped so the tag stays compact.
  assert.ok(!tagAlpha.includes('[1m]') && !tagBeta.includes('[1m]'),
    'trailing [ctx] hint stripped from the display tag');
});
