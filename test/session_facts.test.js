/*-------------------------------------------------------------------------
 *
 * Unit tests for the session-facts layer (P0 of the long-session memory fix):
 *   - facts persist to ~/.hk2/sessions/<pid>/<sid>.facts.json and reload
 *   - dedup on add, substring match on remove, clear-all
 *   - ensureSessionFactsMessage: insert / in-place refresh / removal
 *   - IMMUNITY TO COMPACTION: the facts message is a standing system
 *     message that compactMessages must carry verbatim (it is not in the
 *     foldable set), unlike the KB-context and prior-summary messages.
 *
 * Run:  node --test test/session_facts.test.js
 *----------------------------------------------------------------------*/
import './_learn_setup.js';

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadSessionFacts, addSessionFact, removeSessionFacts,
  renderFactsMessage, ensureSessionFactsMessage, FACTS_HEADER,
} from '../lib/agent/session_facts.js';
import { compactMessages } from '../src/commands/turn_support.js';

const PID = 'proj-facts-rt';
const SID = 'sess-facts-rt';

test.after(async () => {
  // facts live under HK2_HOME/sessions (isolated by _learn_setup.js)
  try { fs.rmSync(path.join(process.env.HK2_HOME, 'sessions', PID), { recursive: true, force: true }); } catch {}
});

/* ----- storage round-trip ----- */

test('facts: add / load round-trip, persisted to the sessions dir', async () => {
  const out = await addSessionFact(PID, SID, '测试环境 IP 是 10.20.30.40', { source: 'unit-test' });
  assert.ok(Array.isArray(out) && out.length === 1);
  const loaded = await loadSessionFacts(PID, SID);
  assert.deepEqual(loaded, ['测试环境 IP 是 10.20.30.40']);
  // file exists at the documented location
  const p = path.join(process.env.HK2_HOME, 'sessions', PID, `${SID}.facts.json`);
  assert.ok(fs.existsSync(p), 'facts file created next to the transcript');
});

test('facts: dedup by normalized text (whitespace/case-insensitive)', async () => {
  await removeSessionFacts(PID, SID, ''); // clean slate for this test
  // Same content, different case + whitespace → one entry.
  await addSessionFact(PID, SID, 'Test IP  10.20.30.40');
  await addSessionFact(PID, SID, 'test ip 10.20.30.40');
  const loaded = await loadSessionFacts(PID, SID);
  assert.equal(loaded.length, 1, 'normalized duplicates are not added twice');
});

test('facts: add second fact, then remove by substring, then clear all', async () => {
  // Start clean for this test's assertions.
  await removeSessionFacts(PID, SID, '');
  await addSessionFact(PID, SID, '测试环境 IP 是 10.20.30.40');
  await addSessionFact(PID, SID, 'postgres 版本 16.2');
  let loaded = await loadSessionFacts(PID, SID);
  assert.equal(loaded.length, 2);
  // remove by substring ("版本")
  const kept = await removeSessionFacts(PID, SID, '版本');
  assert.deepEqual(kept, ['测试环境 IP 是 10.20.30.40']);
  // no-match remove returns null and changes nothing
  assert.equal(await removeSessionFacts(PID, SID, '不存在的关键字'), null);
  // clear all
  const emptied = await removeSessionFacts(PID, SID, '');
  assert.deepEqual(emptied, []);
  assert.deepEqual(await loadSessionFacts(PID, SID), []);
});

test('facts: load with missing file / bad args returns []', async () => {
  assert.deepEqual(await loadSessionFacts(PID, 'no-such-session'), []);
  assert.deepEqual(await loadSessionFacts(null, SID), []);
  assert.equal(await addSessionFact(PID, 'x', '   '), null, 'blank fact rejected');
});

/* ----- message rendering + in-place maintenance ----- */

test('renderFactsMessage: header + bullet list; null when empty', () => {
  assert.equal(renderFactsMessage([]), null);
  assert.equal(renderFactsMessage(null), null);
  const body = renderFactsMessage(['fact one', 'fact two']);
  assert.ok(body.startsWith(FACTS_HEADER));
  assert.ok(body.includes('- fact one'));
  assert.ok(body.includes('- fact two'));
});

test('ensureSessionFactsMessage: insert after system prompt, refresh in place, remove when empty', () => {
  const session = { messages: [{ role: 'system', content: 'main prompt' }] };
  ensureSessionFactsMessage(session, ['f1']);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].role, 'system');
  assert.ok(session.messages[1].content.startsWith(FACTS_HEADER));
  // refresh in place — never a second message
  ensureSessionFactsMessage(session, ['f1', 'f2']);
  assert.equal(session.messages.length, 2, 'in-place refresh, no append');
  assert.ok(session.messages[1].content.includes('- f2'));
  // facts gone → message removed
  ensureSessionFactsMessage(session, []);
  assert.equal(session.messages.length, 1);
});

test('ensureSessionFactsMessage: refresh survives when message moved (finds by header)', () => {
  const session = {
    messages: [
      { role: 'system', content: 'main prompt' },
      { role: 'system', content: `${FACTS_HEADER}\n- f1` },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  };
  ensureSessionFactsMessage(session, ['f1', 'f2']);
  assert.equal(session.messages.filter(m => String(m.content || '').startsWith(FACTS_HEADER)).length, 1);
  assert.ok(session.messages[1].content.includes('- f2'));
});

/* ----- the design core: compaction immunity ----- */
//
// compactMessages must carry the facts message VERBATIM: standing system
// messages (anything not prefixed with the compacted/KB-context headers) are
// preserved, so the facts never depend on the summarizer noticing them.
// Requires >= 6 conversation messages to trigger compaction.

test('facts message SURVIVES compaction verbatim (standing system message, not foldable)', async () => {
  const factsBody = renderFactsMessage(['测试环境 IP 是 10.20.30.40', 'postgres 16.2']) || '';
  const session = {
    llm: null, // force the naive-fallback summary path (no LLM needed)
    messages: [
      { role: 'system', content: 'main system prompt' },
      { role: 'system', content: factsBody },                        // THE facts message
      { role: 'system', content: '## Knowledge-base context for this turn\nstale turn KB' }, // foldable
      { role: 'user', content: 'early question about the test IP' }, // will be compacted away
      { role: 'assistant', content: 'early answer' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ],
  };
  const out = await compactMessages(session);
  assert.ok(out, 'compaction ran (>=6 conversation turns)');
  const factsAfter = out.messages.filter(m => m.role === 'system' && String(m.content).startsWith(FACTS_HEADER));
  assert.equal(factsAfter.length, 1, 'exactly one facts message after compaction');
  assert.equal(factsAfter[0].content, factsBody, 'carried VERBATIM — byte-identical');
  // the stale per-turn KB context WAS folded (contrast: facts is standing)
  assert.equal(out.messages.filter(m => String(m.content || '').startsWith('## Knowledge-base context')).length, 0);
  // and the main prompt is preserved too
  assert.ok(out.messages.some(m => m.content === 'main system prompt'));
});

test('facts message with 0 facts never injects (message-shape compatibility)', () => {
  const session = { messages: [{ role: 'system', content: 'main prompt' }, { role: 'user', content: 'hi' }] };
  ensureSessionFactsMessage(session, []);
  assert.equal(session.messages.length, 2, 'no facts → no message, identical to pre-feature shape');
});

/* ----- P0-2: the three write channels ----- */

// Channel 1: the `remember` tool (toolRemember wrapper + callback).

test('remember tool: persists via callback and reports ok; validates input', async () => {
  // exercise toolRemember through buildTools wiring: call the exported tool
  // executor path directly via the module's buildTools list.
  const { buildTools } = await import('../lib/agent/tools.js');
  const PID2 = 'proj-facts-tool';
  const SID2 = 'sess-facts-tool';
  let refreshCalls = 0;
  const tools = buildTools(null, {
    allowWrite: false,
    remember: async (fact) => {
      const out = await addSessionFact(PID2, SID2, fact, { source: 'remember-tool-test' });
      if (!Array.isArray(out)) return null;
      refreshCalls++;
      return out;
    },
  });
  const rememberTool = tools.find(t => t.name === 'remember');
  assert.ok(rememberTool, 'remember tool registered');
  // invalid input
  assert.match(JSON.stringify(await rememberTool.execute({ fact: '   ' }, {})), /fact required/);
  assert.match(JSON.stringify(await rememberTool.execute({ fact: 'x'.repeat(501) }, {})), /too long/);
  // valid write
  const ok = await rememberTool.execute({ fact: '测试环境地址 10.1.2.3' }, {});
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Fact recorded/);
  assert.equal(refreshCalls, 1);
  const persisted = await loadSessionFacts(PID2, SID2);
  assert.deepEqual(persisted, ['测试环境地址 10.1.2.3']);
  // no callback (non-interactive) → graceful degradation, not an error
  const bare = buildTools(null, { allowWrite: false });
  const bareTool = bare.find(t => t.name === 'remember');
  const degraded = await bareTool.execute({ fact: 'whatever' }, {});
  assert.equal(degraded.ok, false);
  assert.match(degraded.message, /not available in this mode/);
});

// Channel 2: /remember and /forget slash commands.

test('/remember + /forget: record, list, remove-by-substring, clear-all via ctx hooks', async () => {
  const { cmdRemember, cmdForget } = await import('../src/slash/remember.js');
  const PID3 = 'proj-facts-cmd';
  const SID3 = 'sess-facts-cmd';
  const printed = [];
  const memory = { messages: [{ role: 'system', content: 'main' }] };
  const ctx = {
    print: (t) => printed.push(String(t)),
    confirm: async () => true,
    getSessionInfo: () => ({ projectId: PID3, sessionId: SID3 }),
    sessionFacts: {
      refresh: (facts) => {
        memory.sessionFacts = facts;
        ensureSessionFactsMessage(memory, facts);
        return facts;
      },
    },
  };
  // no session → refusal
  await cmdRemember(['x'], { ...ctx, getSessionInfo: () => ({}) });
  assert.ok(printed.some(p => /No active project session/.test(p)));
  printed.length = 0;
  // record
  await cmdRemember(['测试环境', '地址', '10.9.8.7'], ctx);
  assert.ok(printed.some(p => /Recorded/.test(p)));
  const stored = await loadSessionFacts(PID3, SID3);
  assert.equal(stored[0], '测试环境 地址 10.9.8.7');
  assert.ok(memory.messages.some(m => String(m.content).startsWith(FACTS_HEADER)), 'ctx hook refreshed the in-memory message');
  // list
  printed.length = 0;
  await cmdRemember([], ctx);
  assert.ok(printed.some(p => /Session facts \(1\)/.test(p)));
  // remove by substring
  printed.length = 0;
  await cmdForget(['地址'], ctx);
  assert.ok(printed.some(p => /Removed facts matching/.test(p)));
  assert.deepEqual(await loadSessionFacts(PID3, SID3), []);
  assert.ok(!memory.messages.some(m => String(m.content).startsWith(FACTS_HEADER)), 'message removed when facts emptied');
  // no-match remove (facts were just emptied → the honest answer is "nothing to remove")
  printed.length = 0;
  await cmdForget(['不存在'], ctx);
  assert.ok(printed.some(p => /No session facts to remove/.test(p)), 'empty store reports nothing to remove');
  // re-add one and THEN test the no-match path with a non-empty store
  await cmdRemember(['另一条事实'], ctx);
  printed.length = 0;
  await cmdForget(['不存在'], ctx);
  assert.ok(printed.some(p => /No fact matches/.test(p)), 'non-empty store reports no match and lists facts');
});

// Channel 3: compaction-time LLM extraction (fail-open).

test('compaction extracts durable facts from the compacted turns (fail-open)', async () => {
  const PID4 = 'proj-facts-compact';
  const SID4 = 'sess-facts-compact';
  const extractCalls = [];
  const llm = {
    async complete(messages) {
      extractCalls.push(messages);
      const user = messages?.[1]?.content || '';
      if (user.includes('extract durable FACTS') || (messages?.[0]?.content || '').includes('extract durable FACTS')) {
        return JSON.stringify({ facts: ['测试环境地址 10.1.2.3', 'PostgreSQL 16.2'] });
      }
      return 'summary text';
    },
  };
  const mk = (v) => v.map((x, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: x }));
  const session = {
    llm,
    project: { id: PID4 },
    transcript: { sessionId: SID4, logMeta: async () => {} },
    messages: [
      { role: 'system', content: 'main prompt' },
      ...mk(['我们的测试环境地址是 10.1.2.3，数据库是 PostgreSQL 16.2', '好的记下了', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']),
    ],
  };
  const out = await compactMessages(session);
  assert.ok(out, 'compaction ran');
  assert.equal(extractCalls.length >= 1, true, 'extraction LLM call fired');
  const facts = await loadSessionFacts(PID4, SID4);
  assert.deepEqual(facts, ['测试环境地址 10.1.2.3', 'PostgreSQL 16.2']);
});

test('compaction extraction failure does not block compaction (fail-open)', async () => {
  const llm = {
    async complete() { throw new Error('extractor down'); },
  };
  const mk = (v) => v.map((x, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: x }));
  const session = {
    llm,
    project: { id: 'proj-x' },
    transcript: { sessionId: 'sess-x', logMeta: async () => {} },
    messages: [
      { role: 'system', content: 'main prompt' },
      ...mk(['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4']),
    ],
  };
  const out = await compactMessages(session);
  assert.ok(out, 'compaction proceeded despite the extractor throwing');
  // naive fallback summary (llm.complete also failed) still produced a block
  assert.ok(out.messages.some(m => String(m.content).startsWith('## Prior conversation (compacted)')));
});

test('summarizer input keeps the conversation HEAD and TAIL (P1-1: opening facts reach the summary)', async () => {
  const seen = [];
  const llm = {
    async complete(messages) {
      seen.push(messages?.[1]?.content || '');
      return 'summary';
    },
  };
  const openingFact = '我们的测试环境地址是 10.1.2.3 数据库 PostgreSQL 16.2';
  const mk = (v) => v.map((x, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: x }));
  // 70k chars of middle filler so the input exceeds the 48k window: the old
  // tail-only slice dropped the opening fact entirely. The LAST compacted
  // turn (before the 4 kept) must be inside the TAIL half.
  const filler = Array.from({ length: 14 }, (_, i) => ['u' + i + ' ' + 'x'.repeat(3000), 'a' + i + ' ' + 'y'.repeat(3000)]).flat();
  const session = {
    llm,
    project: { id: 'proj-headtail' },
    transcript: { sessionId: 'sess-headtail', logMeta: async () => {} },
    messages: [
      { role: 'system', content: 'main prompt' },
      ...mk([openingFact, 'ok', ...filler, 'last compacted decision: use plan B', 'u1', 'a1', 'u2', 'a2']),
    ],
  };
  await compactMessages(session);
  const summarizeInput = seen.find(t => t.includes('Summarize the following')) || '';
  assert.ok(summarizeInput.includes('10.1.2.3'), 'the OPENING fact is inside the summarizer input (head)');
  assert.ok(summarizeInput.includes('PostgreSQL 16.2'), 'opening version fact survives into the input');
  assert.ok(summarizeInput.includes('last compacted decision: use plan B'), 'the last COMPACTED turn is inside the tail half');
  assert.ok(summarizeInput.includes('[...middle elided'), 'middle elision marker present');
});

// Digest synergy: the session digest exposes the facts to the assessor.

test('buildSessionDigest includes the session-facts section', async () => {
  const { buildSessionDigest } = await import('../src/commands/session_ctx.js');
  const session = {
    lastTask: null,
    planProgress: null,
    sessionFacts: ['测试环境地址 10.1.2.3', 'PostgreSQL 16.2'],
    messages: [],
  };
  const digest = buildSessionDigest(session, '连一下测试库');
  assert.match(digest, /Session facts \(persistent, always in scope\):/);
  assert.ok(digest.includes('10.1.2.3'));
  // absent/empty → no section (fresh sessions unchanged)
  const digest2 = buildSessionDigest({ lastTask: null, planProgress: null, messages: [] }, 'x');
  assert.equal(digest2.includes('Session facts'), false);
});

/* ----- P2: KB retrievability of fact entries ----- */

test('matchPrinciples: a fact buried in the INTRO body is now retrievable (P2-1)', async () => {
  const { matchPrinciples } = await import('../lib/retrieval/context_builder.js');
  const entry = {
    id: 'env-facts',
    title: 'Project environment facts',
    keywords: ['environment', 'facts'],
    intro: '- 测试环境地址 10.1.2.3\n- PostgreSQL 16.2\n- 备用机 standby-04 端口 5433',
  };
  // The query terms appear ONLY in the intro, not in title/keywords — under
  // the old matcher this had ZERO overlap and never matched.
  const hits = matchPrinciples([entry], '10.1.2.3 standby-04 5433');
  assert.equal(hits.length >= 1, true, 'intro-only overlap now matches');
  assert.equal(hits[0].principle.id, 'env-facts');
});

test('matchPrinciples: title hits still outrank intro-only hits (ranking stability)', async () => {
  const { matchPrinciples } = await import('../lib/retrieval/context_builder.js');
  const titleEntry = { id: 't', title: 'wal replay loop', keywords: ['wal'], intro: '' };
  const introEntry = { id: 'i', title: 'Project environment facts', keywords: ['facts'], intro: 'wal details buried here' };
  const hits = matchPrinciples([introEntry, titleEntry], 'wal');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].principle.id, 't', 'the title/keyword match ranks first');
});

test('compaction extraction keeps the conversation HEAD (opening-stated facts reach the extractor)', async () => {
  const seen = [];
  const llm = {
    async complete(messages) {
      const sys = messages?.[0]?.content || '';
      if (sys.includes('extract durable FACTS')) {
        seen.push(messages?.[1]?.content || '');
        return JSON.stringify({ facts: [] });
      }
      return 'summary';
    },
  };
  const openingFact = '我们的测试环境地址是 10.77.77.77 端口 5433';
  const mk = (v) => v.map((x, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: x }));
  // >32k chars of filler so the old tail-only 24k window dropped the opening.
  const filler = Array.from({ length: 10 }, (_, i) => ['u' + i + ' ' + 'x'.repeat(2000), 'a' + i + ' ' + 'y'.repeat(2000)]).flat();
  const session = {
    llm,
    project: { id: 'proj-ex-head' },
    transcript: { sessionId: 'sess-ex-head', logMeta: async () => {} },
    messages: [
      { role: 'system', content: 'main prompt' },
      ...mk([openingFact, 'ok', ...filler, 'u1', 'a1', 'u2', 'a2']),
    ],
  };
  await compactMessages(session);
  const scanInput = seen[0] || '';
  assert.ok(scanInput.includes('10.77.77.77'), 'the OPENING-stated fact is inside the extraction input (head half)');
  assert.ok(scanInput.includes('5433'), 'the opening port fact survives into the extraction input');
  assert.ok(scanInput.includes('fact-extraction input window'), 'middle elision marker present');
});

test('/remember --project appends to the eden env-facts entry (P2-3)', async () => {
  const { cmdRemember } = await import('../src/slash/remember.js');
  const { readKnowledge } = await import('../lib/store/kb_store.js');
  const PID5 = 'proj-env-facts';
  // minimal KB dir so writeKnowledge has somewhere to land
  const { createKbDir } = await import('../lib/store/kb_store.js');
  await createKbDir(PID5).catch(() => {});
  const printed = [];
  const ctx = {
    print: (t) => printed.push(String(t)),
    confirm: async () => true,
    getSessionInfo: () => ({ projectId: PID5, sessionId: 'sess-env-facts' }),
    sessionFacts: { refresh: () => {} },
  };
  await cmdRemember(['--project', '测试环境地址', '10.5.5.5'], ctx);
  assert.ok(printed.some(p => /Also saved to the project-level Eden entry/.test(p)), printed.join(' | '));
  const entry = await readKnowledge(PID5, 'eden', 'env-facts');
  assert.ok(entry, 'env-facts entry created');
  assert.ok(String(entry.intro).includes('10.5.5.5'));
  // dedup on second identical append
  await cmdRemember(['-p', '测试环境地址 10.5.5.5'], ctx);
  const entry2 = await readKnowledge(PID5, 'eden', 'env-facts');
  assert.equal(String(entry2.intro).split('\n').length, 1, 'duplicate append deduped to one bullet');
});
