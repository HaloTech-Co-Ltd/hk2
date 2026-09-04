/**
 * Proposal consumption-semantics tests for the ast_edit → resolve flow.
 *
 * Contract under test (docs/en/reference/agent-tools.md, proposal
 * lifecycle): a proposal is CONSUMED by a successful apply, a discard, or a
 * read/tag/write failure during apply. It is NOT consumed by a
 * permission-denied apply (rules may change; the user can adjust them and
 * retry) or by an invalid action (rejected before the proposal is even
 * read). Expired/LRU-evicted/crashed proposals are gone — no persistence.
 *
 * Consumption is asserted against the real stash (lib/agent/proposals.js),
 * not just the tool's return values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tools = null;
let proposals = null;
let setting = null;

/**
 * Fresh temp project + managed permission layer. The managed setting.json
 * starts permissive (inside-project default already allows rwx) so ast_edit
 * can stage; tests rewrite it to simulate rules changing between preview
 * and resolve — exactly the window the per-file re-check exists for.
 */
async function makeEnv() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-proposal-'));
  const proj = path.join(base, 'proj');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, 'app.js'), 'const alpha = 1;\n');
  const home = path.join(base, 'home');
  await fs.mkdir(path.join(home, 'settings', 'proposal-proj'), { recursive: true });
  process.env.HK2_HOME = home;
  process.env.HK2_PROJECT_SOURCE = proj;
  process.env.HK2_PROJECT_ID = 'proposal-proj';
  setting = await import('../lib/config/setting.js');
  setting.resetPermissionService();
  if (!tools) tools = await import('../lib/agent/tools.js');
  if (!proposals) proposals = await import('../lib/agent/proposals.js');
  proposals._reset();
  const built = tools.buildTools(null, {});
  const by = (n) => built.find(t => t.name === n);
  const managed = path.join(home, 'settings', 'proposal-proj', 'setting.json');
  const setRules = async (permissions) => {
    await fs.writeFile(managed, JSON.stringify({ permissions }));
    setting.resetPermissionService();
  };
  return {
    base, proj, by, setRules,
    appJs: path.join(proj, 'app.js'),
    stage: async () => {
      const r = await by('ast_edit').execute({
        ops: [{ pat: 'const $N = $$$V', out: 'const $N = 2' }],
        paths: [proj],
      });
      assert.equal(r.proposed, true, `ast_edit must stage: ${JSON.stringify(r)}`);
      return r.proposalId;
    },
    cleanup: async () => {
      delete process.env.HK2_HOME;
      delete process.env.HK2_PROJECT_SOURCE;
      delete process.env.HK2_PROJECT_ID;
      proposals?._reset();
      await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test.after(() => { setting?.resetPermissionService?.(); });

test('invalid action is rejected before the proposal is read and does not consume it', async () => {
  const env = await makeEnv();
  try {
    const id = await env.stage();
    assert.ok(proposals.get(id), 'staged proposal is live');

    const bad = await env.by('resolve').execute({ proposal_id: id, action: 'retry' });
    assert.match(bad.error, /action must be 'apply' or 'discard'/);
    assert.ok(proposals.get(id), 'invalid action must leave the proposal active');

    // The same proposal is still usable afterwards.
    const ok = await env.by('resolve').execute({ proposal_id: id, action: 'discard' });
    assert.equal(ok.discarded, 1);
    assert.equal(proposals.get(id), null, 'discard consumes the proposal');
  } finally {
    await env.cleanup();
  }
});

test('permission-denied apply does not consume the proposal; it applies after the rule is lifted', async () => {
  const env = await makeEnv();
  try {
    const id = await env.stage();

    // Rules change between the ast_edit preview and resolve: deny writes on
    // the target. The per-file re-check at apply time must reject.
    await env.setRules([{ path: 'app.js', deny: 'w' }]);
    const denied = await env.by('resolve').execute({ proposal_id: id, action: 'apply' });
    assert.match(denied.error, /permission denied/);
    assert.equal(denied.applied, undefined);
    assert.ok(proposals.get(id), 'permission denial must leave the proposal active');
    assert.equal((await fs.readFile(env.appJs, 'utf8')), 'const alpha = 1;\n',
      'denied apply must not touch the file');

    // Lift the deny: the SAME proposal id now applies.
    await env.setRules([]);
    const ok = await env.by('resolve').execute({ proposal_id: id, action: 'apply' });
    assert.equal(ok.applied, 1);
    assert.match(await fs.readFile(env.appJs, 'utf8'), /alpha = 2/, 'apply writes the staged edit');
    assert.equal(proposals.get(id), null, 'successful apply consumes the proposal');
  } finally {
    await env.cleanup();
  }
});

test('read failure and stale tag consume the proposal (rolled back, not retryable)', async () => {
  const env = await makeEnv();
  try {
    // Read failure: target vanishes between preview and apply.
    const idRead = await env.stage();
    await fs.rm(env.appJs);
    const readFail = await env.by('resolve').execute({ proposal_id: idRead, action: 'apply' });
    assert.match(readFail.error, /read failed for/);
    assert.equal(readFail.rolledBack, 0);
    assert.equal(proposals.get(idRead), null, 'read failure consumes the proposal');

    // Stale tag: target changes on disk between preview and apply.
    await fs.writeFile(env.appJs, 'const alpha = 1;\n');
    const idTag = await env.stage();
    await fs.writeFile(env.appJs, 'const alpha = 1; // external edit\n');
    const stale = await env.by('resolve').execute({ proposal_id: idTag, action: 'apply' });
    assert.match(stale.error, /stale tag for/);
    assert.equal(stale.rolledBack, 0);
    assert.equal(proposals.get(idTag), null, 'stale-tag failure consumes the proposal');
    assert.match(await fs.readFile(env.appJs, 'utf8'), /external edit/,
      'stale-tag apply must not overwrite the external edit');
  } finally {
    await env.cleanup();
  }
});

test('write failure consumes the proposal', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // Permission-based write failure does not apply to root; read/stale-tag
    // consumption is covered above.
    return;
  }
  const env = await makeEnv();
  try {
    const id = await env.stage();
    // Readable but not writable: the re-read (tag check) succeeds, the
    // write itself fails.
    await fs.chmod(env.appJs, 0o444);
    const fail = await env.by('resolve').execute({ proposal_id: id, action: 'apply' });
    assert.match(fail.error, /write failed for/);
    assert.equal(fail.rolledBack, 0);
    assert.equal(proposals.get(id), null, 'write failure consumes the proposal');
  } finally {
    await env.cleanup();
  }
});
