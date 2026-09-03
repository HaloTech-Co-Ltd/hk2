/**
 * /remember, /forget — session-facts management.
 *
 *   /remember <fact>       record a session-scoped fact (environment facts,
 *                          constraints, preferences — anything later turns
 *                          must not forget); dedup'd, persisted to
 *                          ~/.hk2/sessions/<pid>/<sid>.facts.json, injected
 *                          into every subsequent turn via the standing
 *                          "## Session facts" system message, immune to
 *                          context compaction.
 *   /remember              list the current facts
 *   /forget <substring>    remove matching fact(s) (substring match)
 *   /forget                remove ALL facts (with confirmation)
 *
 * The command writes to disk + refreshes the in-memory message via the
 * ctx.sessionFacts hook (wired in buildBaseCtx); when the hook is absent
 * (non-interactive hosts) it degrades to a read-only notice.
 */

import {
  loadSessionFacts, addSessionFact, removeSessionFacts, ensureSessionFactsMessage,
} from '../../lib/agent/session_facts.js';

const ENV_FACTS_ID = 'env-facts';

/**
 * /remember --project <fact>: ALSO append the fact to the project-level Eden
 * entry `env-facts` so it survives across sessions (session facts die with
 * the session file; env-facts is project-scoped). The entry is append-
 * maintained (one bullet per fact) and its intro body is searchable via
 * matchPrinciples (P2-1) + kb_search_knowledge. Hot-reloads the in-memory
 * runtime so the NEXT turn's retrieval already sees it. Best-effort: KB
 * failures degrade to a notice; the session fact is still recorded.
 */
async function appendProjectEnvFact(ctx, fact) {
  const info = ctx.getSessionInfo?.() || {};
  const pid = info.projectId;
  if (!pid) return { ok: false, reason: 'no project' };
  try {
    const { readKnowledge, writeKnowledge } = await import('../../lib/store/kb_store.js');
    const existing = await readKnowledge(pid, 'eden', ENV_FACTS_ID).catch(() => null);
    const lines = existing?.intro ? String(existing.intro).split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : [];
    const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!lines.some(l => norm(l) === norm(fact))) lines.push(fact);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
    await writeKnowledge(pid, 'eden', {
      id: ENV_FACTS_ID,
      title: existing?.title || 'Project environment facts',
      intro: lines.map(l => `- ${l}`).join('\n'),
      keywords: existing?.keywords || ['environment', 'facts', 'env', '环境', '事实'],
      createdAt: existing?.createdAt,
    });
    // Hot-reload so the next turn's matchPrinciples sees it immediately.
    // Strictly best-effort: a runtime that cannot load (e.g. the KB has no
    // inverted index yet — knowledge-only writes like this one) is skipped;
    // the fact still lands on disk and the runtime picks it up on the next
    // full load (/kb update, session restart).
    try {
      const { getRuntime } = await import('../../lib/retrieval/kb_runtime.js');
      const rt = await getRuntime(pid).catch(() => null);
      if (rt?.knowledgeBySpace) {
        const { listKnowledge } = await import('../../lib/store/kb_store.js');
        rt.knowledgeBySpace.eden = await listKnowledge(pid, 'eden').catch(() => rt.knowledgeBySpace.eden);
      }
    } catch { /* runtime reload is best-effort */ }
    return { ok: true, total: lines.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function cmdRemember(args, ctx) {
  const argv = (args || []).slice();
  const asProject = argv[0] === '--project' || argv[0] === '-p';
  if (asProject) argv.shift();
  const text = argv.join(' ').trim();
  const info = ctx.getSessionInfo?.() || {};
  const pid = info.projectId;
  const sid = info.sessionId;
  if (!pid || !sid) {
    ctx.print('[remember] No active project session — facts need a running session.');
    return;
  }
  if (!text) {
    const facts = await loadSessionFacts(pid, sid);
    if (facts.length === 0) {
      ctx.print('No session facts yet. Usage: /remember <fact>  (e.g. /remember 测试环境地址 10.1.2.3)');
      return;
    }
    ctx.print(`Session facts (${facts.length}):`);
    facts.forEach((f, i) => ctx.print(`  ${i + 1}. ${f}`));
    ctx.print(styleDim('Remove with /forget <substring>; they persist for this session and survive compaction.'));
    return;
  }
  const updated = await addSessionFact(pid, sid, text, { source: '/remember' });
  if (!Array.isArray(updated)) {
    ctx.print('[remember] Failed to persist the fact (storage error). It is NOT recorded.');
    return;
  }
  ctx.print(`Recorded: ${text}`);
  if (ctx.sessionFacts?.refresh) ctx.sessionFacts.refresh(updated);
  else ctx.print('(note: the live message refresh hook is unavailable here; the fact applies from the next turn.)');
  if (asProject) {
    const res = await appendProjectEnvFact(ctx, text);
    if (res.ok) ctx.print(`Also saved to the project-level Eden entry "${ENV_FACTS_ID}" (${res.total} fact(s)) — available across sessions.`);
    else ctx.print(`(note: --project save failed: ${res.reason}; the fact is still recorded for this session.)`);
  }
}

export async function cmdForget(args, ctx) {
  const query = (args || []).join(' ').trim();
  const info = ctx.getSessionInfo?.() || {};
  const pid = info.projectId;
  const sid = info.sessionId;
  if (!pid || !sid) {
    ctx.print('[forget] No active project session.');
    return;
  }
  const current = await loadSessionFacts(pid, sid);
  if (current.length === 0) {
    ctx.print('No session facts to remove.');
    return;
  }
  if (!query) {
    // Clear-all: confirm first.
    const ok = await ctx.confirm(`Remove ALL ${current.length} session fact(s)? (y/N) `, { title: 'Forget all facts' });
    if (!ok) { ctx.print('Cancelled.'); return; }
    const emptied = await removeSessionFacts(pid, sid, '');
    if (ctx.sessionFacts?.refresh) ctx.sessionFacts.refresh(emptied || []);
    ctx.print('All session facts removed.');
    return;
  }
  const kept = await removeSessionFacts(pid, sid, query);
  if (kept === null) {
    ctx.print(`No fact matches "${query}". Current facts (${current.length}):`);
    current.forEach((f, i) => ctx.print(`  ${i + 1}. ${f}`));
    return;
  }
  if (ctx.sessionFacts?.refresh) ctx.sessionFacts.refresh(kept);
  ctx.print(`Removed facts matching "${query}" (${current.length - kept.length} removed, ${kept.length} left).`);
}

// Local dim-style helper to avoid pulling the full style module for one line.
function styleDim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}
