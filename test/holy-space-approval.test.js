/*-------------------------------------------------------------------------
 *
 * Unit tests for the Holy-Space write-approval gate.
 *
 * Regression: kb_save_knowledge used to call writeKnowledge() directly,
 * silently persisting to Holy Space WITHOUT ever prompting the user - a
 * serious violation of the "Holy updates ALWAYS require explicit approval"
 * contract. This test pins the fix: Holy writes MUST go through the
 * knowledgeConfirm callback, and a refusal MUST NOT touch disk.
 *
 * Run:  node --test test/holy-space-approval.test.js
 *----------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// kb_store.js caches KB_ROOT at module-load time from HK2_KB_DIR (preferred)
// or HK2_HOME/KB_ROOT. We must set HK2_KB_DIR BEFORE importing any module
// that transitively imports kb_store (tools.js does). ESM hoists static
// imports ahead of top-level code, so we set the env here and use dynamic
// import() below to load the modules AFTER the env is in place.
let tmpKbRoot = '';
let origKbDir = '';
let origHome = '';
const PROJECT_ID = 'holy-approval-test';
let buildTools, executeToolCall, readKnowledge, listKnowledge;

test.before(async () => {
  origKbDir = process.env.HK2_KB_DIR || '';
  origHome = process.env.HK2_HOME || '';
  tmpKbRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hk2-kb-'));
  // Point BOTH at the temp root: kb_store reads HK2_KB_DIR first; home.js
  // reads HK2_HOME for its own paths (sessions etc.).
  process.env.HK2_KB_DIR = tmpKbRoot;
  process.env.HK2_HOME = tmpKbRoot;
  ({ buildTools, executeToolCall } = await import('../lib/agent/tools.js'));
  ({ readKnowledge, listKnowledge } = await import('../lib/store/kb_store.js'));
});

test.after(async () => {
  if (origKbDir) process.env.HK2_KB_DIR = origKbDir; else delete process.env.HK2_KB_DIR;
  if (origHome) process.env.HK2_HOME = origHome; else delete process.env.HK2_HOME;
  await fs.rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
});

// Minimal rt stub: toolKbSaveKnowledge only needs rt.name + rt.reloadKnowledge.
function mockRt() {
  return {
    name: PROJECT_ID,
    reloadKnowledge: () => {},
  };
}

const sampleEntry = {
  space: 'holy',
  id: 'sample-design-principle',
  title: 'Sample design principle',
  intro: 'A self-contained prose explanation of a stable concept.',
  key_files: ['src/example.js'],
  key_symbols: ['exampleFn'],
  keywords: ['example', 'design'],
};

test('Holy write is REFUSED when knowledgeConfirm returns false, and disk is untouched', async () => {
  let confirmCalled = false;
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async (space, entry) => {
      confirmCalled = true;
      assert.equal(space, 'holy');
      assert.equal(entry.id, 'sample-design-principle');
      return false; // user declines
    },
  });
  const res = await executeToolCall(tools, { name: 'kb_save_knowledge', arguments: sampleEntry });
  assert.ok(confirmCalled, 'knowledgeConfirm MUST be invoked for a Holy write');
  assert.equal(res.ok, true);
  assert.equal(res.result.saved, false);
  assert.equal(res.result.cancelled, true);
  // Critical invariant: nothing was written to Holy Space.
  const written = await readKnowledge(PROJECT_ID, 'holy', sampleEntry.id).catch(() => null);
  assert.equal(written, null, 'NO entry must be persisted after a refusal');
  const all = await listKnowledge(PROJECT_ID, 'holy').catch(() => []);
  assert.equal(all.length, 0, 'Holy space must remain empty after refusal');
});

test('Holy write PROCEEDS only after knowledgeConfirm returns true', async () => {
  let confirmCalled = false;
  const entry = { ...sampleEntry, id: 'approved-principle' };
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => { confirmCalled = true; return true; },
  });
  const res = await executeToolCall(tools, { name: 'kb_save_knowledge', arguments: entry });
  assert.ok(confirmCalled, 'confirm must be called');
  assert.equal(res.result.saved, true);
  assert.equal(res.result.space, 'holy');
  // Entry actually landed on disk.
  const onDisk = await readKnowledge(PROJECT_ID, 'holy', entry.id);
  assert.ok(onDisk, 'entry persisted after approval');
  assert.equal(onDisk.title, 'Sample design principle');
});

test('Holy write is REFUSED (fail-closed) when NO knowledgeConfirm callback is wired', async () => {
  // Simulates a non-interactive caller that forgot to wire confirmation.
  // Holy is the source of truth - we must NEVER silently write it.
  const entry = { ...sampleEntry, id: 'fail-closed-principle' };
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    // knowledgeConfirm intentionally omitted
  });
  const res = await executeToolCall(tools, { name: 'kb_save_knowledge', arguments: entry });
  assert.equal(res.result.saved, false);
  assert.equal(res.result.cancelled, true);
  assert.match(res.result.error, /Refused.*confirmation/i);
  const onDisk = await readKnowledge(PROJECT_ID, 'holy', entry.id).catch(() => null);
  assert.equal(onDisk, null, 'fail-closed: nothing written without a confirm callback');
});

test('Eden write skips confirm when HK2_ENABLE_AUTO_LEARN=1', async () => {
  process.env.HK2_ENABLE_AUTO_LEARN = '1';
  let confirmCalled = false;
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => { confirmCalled = true; return true; },
  });
  const res = await executeToolCall(tools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, space: 'eden', id: 'eden-pattern' },
  });
  assert.equal(confirmCalled, false, 'Eden + autoLearn must NOT prompt');
  assert.equal(res.result.saved, true);
  assert.equal(res.result.space, 'eden');
  const onDisk = await readKnowledge(PROJECT_ID, 'eden', 'eden-pattern');
  assert.ok(onDisk, 'Eden entry persisted without prompting under auto-learn');
  delete process.env.HK2_ENABLE_AUTO_LEARN;
});

test('Eden write still prompts when HK2_ENABLE_AUTO_LEARN is off', async () => {
  delete process.env.HK2_ENABLE_AUTO_LEARN;
  let confirmCalled = false;
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => { confirmCalled = true; return false; },
  });
  const res = await executeToolCall(tools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, space: 'eden', id: 'eden-prompt' },
  });
  assert.ok(confirmCalled, 'Eden must prompt when auto-learn is off');
  assert.equal(res.result.saved, false);
  assert.equal(res.result.cancelled, true);
  const onDisk = await readKnowledge(PROJECT_ID, 'eden', 'eden-prompt').catch(() => null);
  assert.equal(onDisk, null, 'refused Eden write must not touch disk');
});

test('Holy write is refused when confirm callback throws (defensive)', async () => {
  const entry = { ...sampleEntry, id: 'throw-principle' };
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => { throw new Error('readline exploded'); },
  });
  const res = await executeToolCall(tools, { name: 'kb_save_knowledge', arguments: entry });
  assert.equal(res.result.saved, false);
  assert.equal(res.result.cancelled, true);
  const onDisk = await readKnowledge(PROJECT_ID, 'holy', entry.id).catch(() => null);
  assert.equal(onDisk, null, 'a throwing confirm must not write to Holy');
});

/* ---- y/N/E tri-state: NEW Holy writes can be redirected to Eden -------- */

test('confirm receives isNew=true for a NEW Holy entry', async () => {
  let seenIsNew = null;
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async (_space, entry) => { seenIsNew = entry.isNew; return false; },
  });
  await executeToolCall(tools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, id: 'isnew-check' },
  });
  assert.equal(seenIsNew, true, 'a fresh id must be flagged isNew=true');
});

test("confirm('eden') redirects a NEW Holy write into Eden (no re-confirm)", async () => {
  let calls = 0;
  const tools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => { calls++; return 'eden'; },
  });
  const res = await executeToolCall(tools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, id: 'redirected-entry' },
  });
  assert.equal(calls, 1, 'redirect must not trigger a second confirmation');
  assert.equal(res.result.saved, true);
  assert.equal(res.result.space, 'eden', 'the entry must land in Eden, not Holy');
  const inHoly = await readKnowledge(PROJECT_ID, 'holy', 'redirected-entry').catch(() => null);
  const inEden = await readKnowledge(PROJECT_ID, 'eden', 'redirected-entry');
  assert.equal(inHoly, null, 'Holy must stay untouched after an E redirect');
  assert.ok(inEden, 'redirected entry persisted in Eden');
});

test("confirm('eden') does NOT redirect an UPDATE of an existing Holy entry", async () => {
  // Seed Holy with the entry first (approved write).
  const seedTools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async () => true,
  });
  await executeToolCall(seedTools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, id: 'existing-holy', intro: 'v1' },
  });
  // Now attempt an update whose confirm answers 'eden' — must be treated as
  // NOT approved (updates keep the plain y/N contract; 'eden' is not y).
  let seenIsNew = null;
  const updTools = buildTools(mockRt(), {
    allowWrite: false,
    projectId: PROJECT_ID,
    knowledgeConfirm: async (_s, entry) => { seenIsNew = entry.isNew; return 'eden'; },
  });
  const res = await executeToolCall(updTools, {
    name: 'kb_save_knowledge',
    arguments: { ...sampleEntry, id: 'existing-holy', intro: 'v2' },
  });
  assert.equal(seenIsNew, false, 'an existing id must be flagged isNew=false');
  assert.equal(res.result.saved, false);
  assert.equal(res.result.cancelled, true, "'eden' on an update is a refusal, not a redirect");
  const onDisk = await readKnowledge(PROJECT_ID, 'holy', 'existing-holy');
  assert.ok(onDisk, 'original Holy entry still present');
  assert.equal(onDisk.intro, 'v1', 'Holy entry must not be modified by the refused update');
  const inEden = await readKnowledge(PROJECT_ID, 'eden', 'existing-holy').catch(() => null);
  assert.equal(inEden, null, 'no Eden copy may be created from an update refusal');
});
