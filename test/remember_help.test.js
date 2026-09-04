/*-------------------------------------------------------------------------
 * Behavior tests for the /remember slash command vs the agent `remember`
 * tool, plus the central /help coverage added for flat commands.
 *
 * Contract under test (docs/en/reference/slash-commands.md#remember):
 *   - /remember persists via addSessionFact() FIRST; a missing
 *     ctx.sessionFacts.refresh hook only delays the in-memory standing
 *     message refresh — it never blocks the save, and the output must not
 *     claim the fact was not recorded.
 *   - Only a storage failure leaves the fact unrecorded ("NOT recorded").
 *   - The agent `remember` TOOL is different: no persistence callback →
 *     ok:false (never a silent success).
 *   - /help <command> is the universal detailed-help entry: remember,
 *     forget, help, and the exit→quit alias all resolve.
 * ----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dispatchSlash, SLASH_COMMANDS } from '../src/slash/index.js';
import { renderHelp } from '../src/slash/help.js';
import { loadSessionFacts } from '../lib/agent/session_facts.js';
import { buildTools } from '../lib/agent/tools.js';

const PID = 'proj-remember-help';
const SID = 'sess-remember-help';

function makeCtx({ withRefreshHook = false } = {}) {
  const prints = [];
  const ctx = {
    print: (t) => prints.push(String(t)),
    getSessionInfo: () => ({ projectId: PID, sessionId: SID }),
  };
  if (withRefreshHook) ctx.sessionFacts = { refresh: () => {} };
  return { ctx, prints };
}

test.after(async () => {
  try { await fs.rm(path.join(process.env.HK2_HOME, 'sessions', PID), { recursive: true, force: true }); } catch {}
});

/* ── /remember persistence semantics ─────────────────────────────────── */

test('/remember persists the fact even without a live-refresh hook', async () => {
  const { ctx, prints } = makeCtx({ withRefreshHook: false });
  assert.equal(ctx.sessionFacts, undefined, 'fixture: no refresh hook wired');

  assert.equal(await dispatchSlash('/remember test fact', ctx), true);

  // The disk write is the source of truth: a fresh load sees the fact.
  const facts = await loadSessionFacts(PID, SID);
  assert.deepEqual(facts, ['test fact']);

  const out = prints.join('\n');
  assert.match(out, /Recorded: test fact/, 'the save is reported as recorded');
  assert.match(out, /refresh hook is unavailable/, 'notes the missing live-refresh hook');
  assert.doesNotMatch(out, /not recorded/i, 'must NOT claim the fact was not recorded');
});

test('/remember reports NOT recorded only when persistence itself fails', async () => {
  // Block the facts-file write by placing a DIRECTORY where the facts file
  // would be written (writeJsonAtomic cannot rename onto a directory). Uses
  // a dedicated session id so the fact persisted by the test above is not
  // disturbed.
  const failSid = 'sess-remember-fail';
  const factsFile = path.join(process.env.HK2_HOME, 'sessions', PID, `${failSid}.facts.json`);
  await fs.mkdir(path.dirname(factsFile), { recursive: true });
  await fs.mkdir(factsFile, { recursive: true });
  try {
    const { ctx, prints } = makeCtx({ withRefreshHook: false });
    ctx.getSessionInfo = () => ({ projectId: PID, sessionId: failSid });
    assert.equal(await dispatchSlash('/remember doomed fact', ctx), true);
    const out = prints.join('\n');
    assert.match(out, /NOT recorded/, 'storage failure is the one NOT-recorded case');
    assert.doesNotMatch(out, /Recorded: doomed fact/);
  } finally {
    await fs.rm(factsFile, { recursive: true, force: true });
  }
});

test('agent remember tool without a persistence callback returns ok:false', async () => {
  const tools = buildTools({}, { projectId: PID }); // no `remember` callback
  const remember = tools.find(t => t.name === 'remember');
  assert.ok(remember, 'remember tool is present');
  const result = await remember.execute({ fact: 'staging endpoint 192.0.2.10' });
  assert.equal(result.ok, false, 'no callback must be an explicit failure');
  assert.ok(!result.error, 'a missing callback is ok:false, not an error');
});

/* ── central /help coverage ──────────────────────────────────────────── */

test('/help <command> resolves for every registered command, flat ones included', async () => {
  const names = SLASH_COMMANDS.map(c => c.name.slice(1));
  assert.ok(names.length >= 14, 'registry sanity');
  for (const name of names) {
    const lines = renderHelp(name);
    assert.ok(Array.isArray(lines) && lines.length > 0, `/help ${name} must resolve to help text`);
  }
  // dispatch-level spot check: /help remember prints usage, not Unknown.
  const { ctx, prints } = makeCtx();
  assert.equal(await dispatchSlash('/help remember', ctx), true);
  const out = prints.join('\n');
  assert.match(out, /Usage: \/remember \[--project\|-p\] \[fact\]/);
  assert.doesNotMatch(out, /Unknown command/);
});

test('/help forget documents substring removal and remove-all with confirmation', () => {
  const out = renderHelp('forget').join('\n');
  assert.match(out, /Usage: \/forget \[substring\]/);
  assert.match(out, /substring/i);
  assert.match(out, /remove ALL facts/i);
  assert.match(out, /y\/N confirmation/i);
});

test('/help exit is equivalent to /help quit', () => {
  assert.deepEqual(renderHelp('exit'), renderHelp('quit'));
});

test('/help help describes the central help entry', () => {
  const out = renderHelp('help').join('\n');
  assert.match(out, /Usage: \/help \[command\]/);
  assert.match(out, /central detailed-help entry/i);
  // It must NOT promise that every command family supports <command> help.
  assert.doesNotMatch(out, /every family also supports/i);
  assert.doesNotMatch(out, /每个命令族.*help/);
});

test('/session one-line summary lists compact, not the nonexistent clear', () => {
  const session = SLASH_COMMANDS.find(c => c.name === '/session');
  assert.ok(session);
  assert.match(session.description, /compact/);
  assert.doesNotMatch(session.description, /clear/);
});

test('flat commands do not grow family-local help branches', async () => {
  // /remember help still records the literal fact "help" (argument semantics
  // unchanged); /clear help still clears. Lock the no-special-casing rule.
  const { ctx, prints } = makeCtx();
  await dispatchSlash('/remember help', ctx);
  const facts = await loadSessionFacts(PID, SID);
  assert.ok(facts.includes('help'), '/remember help records the fact "help"');
  assert.match(prints.join('\n'), /Recorded: help/);
});
