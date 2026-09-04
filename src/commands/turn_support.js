/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Turn-support helpers shared by the agent-turn pipeline — context
 * compaction, working-tree collection, and env parsing. UI-agnostic: output
 * goes through the `ctx.print` / caller-supplied channels only. Extracted
 * from interactive.js so the TUI front-end reuses the exact same behavior.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { estimateTokensFromChars } from '../../lib/llm/client.js';
import { getPhaseModelRef } from '../../lib/config/home.js';
import { runPhaseWithSkipOnUnreachable } from '../phase_fallback.js';
import { reviewCode, buildCodeReviewContent, createVerdictFilter } from '../../lib/agent/code_review.js';
import * as style from '../../lib/agent/style.js';
import { fmtTok } from './status_format.js';
import { confirmThreeWay } from './session_ctx.js';

/**
 * Parse a 0/1 env flag. Returns defaultValue if unset; treats 0/no/false/off as false.
 */
export function envFlag(name, defaultValue = 0) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return !!defaultValue;
  return /^(1|yes|true|on)$/i.test(v.trim());
}

/**
 * Parse an integer-percentage env var (0-100). Returns defaultValue if unset,
 * unparseable, or out of range (clamped to 1..100 so 0 can't disable the check
 * by accident).
 */
export function envPercent(name, defaultValue = 90) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return defaultValue;
  const n = Number.parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.max(1, Math.min(100, n));
}

/**
 * Estimate the input-token size of a message list (chars → tokens, ~4 chars
 * per token). Used as the fallback when the provider hasn't reported a real
 * usage value for the last call.
 */
/**
 * Calibrated post-compaction context estimate (ported from main's
 * interactive.js during the merge): a raw chars-per-4 guess freezes the
 * status bar at the pre-compact peak and skews the next auto-compact
 * threshold check. Calibrate against the best REAL measurement this
 * session has seen (loopPeakIn / callIn / lastContextTokens — the last
 * matters because maybeAutoCompact runs at the TOP of the next turn,
 * after loopPeakIn was reset but before its snapshot reads), with the
 * factor clamped so CJK-heavy text or a one-off huge tool result cannot
 * degenerate the calibration.
 * @returns {number} the estimate (also landed in the session's token slots)
 */
export function applyCompactTokenEstimate(session, preEstimate) {
  const real = Math.max(
    session.tokens?.loopPeakIn || 0,
    session.tokens?.callIn || 0,
    session.lastContextTokens || 0
  );
  const postEstimate = estimateMessagesTokens(session.messages);
  let est = postEstimate;
  if (real > 0 && preEstimate > 0) {
    const factor = Math.max(0.25, Math.min(4, real / preEstimate));
    est = Math.round(postEstimate * factor);
  }
  session.tokens.callIn = est;
  session.tokens.loopPeakIn = est;
  session.lastContextTokens = est;
  session.statusBar?.update();
  return est;
}

export function estimateMessagesTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (m.content) chars += JSON.stringify(m.content).length;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) chars += JSON.stringify(tc).length;
    }
  }
  return estimateTokensFromChars(chars);
}

/**
 * Run an external command and resolve with { ok, out }. Never rejects - a
 * non-zero exit or spawn failure resolves with ok:false so callers can degrade
 * gracefully (used by Code Review to collect a working-tree diff).
 */
export function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').toString() });
    });
  });
}

/**
 * Collect the working-tree result of a plan execution for Code Review: the
 * tracked diff (staged + unstaged vs HEAD) plus the contents of untracked text
 * files (new files the assistant wrote, which `git diff HEAD` does not cover),
 * and a list of changed files. Best-effort - returns empty fields when git is
 * unavailable or the project path isn't a git repo.
 */
export async function collectWorkingTreeDiff(sourcePath) {
  const empty = { diffText: '', changedFiles: [] };
  if (!sourcePath) return empty;
  try {
    // NOTE: `-C <path>` is a GLOBAL git option and MUST come BEFORE the
    // subcommand. `git status --porcelain -C <path>` fails with
    // "unknown switch `C'" (exit 129), which silently emptied changedFiles
    // and skipped untracked-file collection entirely.
    const [diffRes, statusRes, untrackedRes] = await Promise.all([
      execFileAsync('git', ['-C', sourcePath, 'diff', 'HEAD', '--unified=3']),
      execFileAsync('git', ['-C', sourcePath, 'status', '--porcelain']),
      execFileAsync('git', ['-C', sourcePath, 'ls-files', '--others', '--exclude-standard']),
    ]);
    if (!diffRes.ok && !statusRes.ok) return empty;

    // Porcelain lines are "XY <path>" (2 status cols + 1 space). Renames are
    // "R  old -> new": keep the destination. Paths with special chars are
    // C-quoted by git: strip the surrounding quotes.
    const changedFiles = statusRes.ok
      ? statusRes.out.split('\n').map((l) => {
          let f = l.slice(3).trim();
          if (f.startsWith('"') && f.endsWith('"')) f = f.slice(1, -1);
          const arrow = f.indexOf(' -> ');
          if (arrow >= 0) f = f.slice(arrow + 4);
          return f;
        }).filter((f) => f.trim())
      : [];

    let diffText = diffRes.ok ? diffRes.out : '';

    // Include new (untracked) files, which `git diff HEAD` does not cover.
    if (untrackedRes.ok && untrackedRes.out.trim()) {
      const newFiles = untrackedRes.out.split('\n').map((f) => f.trim()).filter(Boolean);
      for (const f of newFiles.slice(0, 50)) {
        try {
          const abs = path.join(sourcePath, f);
          const stat = await fs.stat(abs);
          if (!stat.isFile()) continue;
          // Cap each new file's body so a single huge generated file can't blow
          // up the review prompt (buildCodeReviewContent truncates again later).
          const content = (await fs.readFile(abs, 'utf8')).slice(0, 16000);
          const lines = content.split('\n');
          if (lines[lines.length - 1] === '') lines.pop(); // trailing newline
          diffText += `\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n` + content;
        } catch { /* skip unreadable / binary files */ }
      }
    }

    return { diffText, changedFiles };
  } catch {
    return empty;
  }
}

/**
 * Summarize a list of prior messages into a compact brief using the LLM so the
 * compressed context retains as much task-relevant information as possible.
 *
 * Includes tool results (file contents, bash output, KB hits) because those
 * carry the real work product; a raw user/assistant dump loses them entirely.
 * The caller falls back to naive truncation on any LLM error.
 */
export async function summarizeConversation(llm, messages) {
  const parts = [];
  for (const m of messages) {
    let body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (m.role === 'tool') {
      body = `tool_result(${m.tool_call_id || '?'}): ${body}`;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        body += `\n[tool_call ${tc.name}] ${typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {})}`;
      }
    }
    parts.push(`${m.role.toUpperCase()}: ${body}`);
  }
  const raw = parts.join('\n\n');
  // P1-1: head+tail split instead of tail-only. The conversation OPENING is
  // where the user states the goal and the environment facts (addresses,
  // versions, constraints); a tail-only window silently dropped exactly that
  // from the summarizer's INPUT — the summary could not preserve what it
  // never saw. 16k head + 32k tail keeps both the opening facts and the
  // recent decisions within the 48k budget.
  const HEAD = 16000, TAIL = 32000;
  let input = raw;
  if (raw.length > HEAD + TAIL) {
    input = raw.slice(0, HEAD) + '\n\n[...middle elided by the compaction input window...]\n\n' + raw.slice(raw.length - TAIL);
  }
  const summary = await llm.complete([
    {
      role: 'system',
      content: 'You are a context-compaction assistant for an AI coding agent. Produce a dense, faithful summary that preserves everything the agent needs to continue: the user\'s goal, decisions made, completed work, files changed and their paths, code locations, constraints, errors and fixes, and any pending plan steps. FACTUAL VALUES MUST SURVIVE VERBATIM: any concrete value the user stated (addresses, hosts, ports, version numbers, identifiers, paths, account names, quantitative constraints) must be copied into the summary character-for-character, never paraphrased or rounded. Do not invent facts; if a detail is unclear, say "unclear".',
    },
    {
      role: 'user',
      content: `Summarize the following prior conversation into a compact brief the agent can use as background context:\n\n${input}`,
    },
  ], {
    maxChars: 12000,
    temperature: 0.1,
    enableReasoning: false,
    timeoutMs: 60000,
  });
  return (summary || '').trim();
}

/**
 * Extract durable user-stated FACTS from messages about to be compacted away
 * (P0-2 channel 3, the fallback that catches facts the user never explicitly
 * asked to remember). One small LLM call, strict JSON, fail-open: any error,
 * timeout, or unparseable output returns [] — extraction must never block or
 * break compaction. Content-agnostic by design: the prompt lists CATEGORIES
 * (endpoints/addresses, ports, versions, identifiers, constraints,
 * preferences), not specific formats, so it generalizes beyond any single
 * example.
 */
async function extractCompactedFacts(llm, messages) {
  if (!llm) return [];
  try {
    const parts = [];
    for (const m of messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const body = typeof m.content === 'string' ? m.content : '';
      if (!body.trim()) continue;
      parts.push(`${m.role.toUpperCase()}: ${body.slice(0, 2000)}`);
    }
    if (parts.length === 0) return [];
    // P1-1 parity: head+tail split instead of tail-only. The conversation
    // OPENING is where the user states environment facts; a tail-only window
    // dropped exactly that from the extractor's INPUT — the same head-loss
    // defect the summarizer's input window just lost. 8k head + 16k tail
    // within the same 24k budget.
    const joined = parts.join('\n\n');
    const EX_HEAD = 8000, EX_TAIL = 16000;
    let scan = joined;
    if (joined.length > EX_HEAD + EX_TAIL) {
      scan = joined.slice(0, EX_HEAD) + '\n\n[...middle elided by the fact-extraction input window...]\n\n' + joined.slice(joined.length - EX_TAIL);
    }
    const raw = await llm.complete([
      {
        role: 'system',
        content: 'You extract durable FACTS stated by the user in a conversation that is about to be summarized away. Facts are short, self-contained, and useful for the REST of the session: environment endpoints / addresses / ports, version numbers, account or machine names (never secrets themselves), deployment constraints, naming conventions, explicit user preferences. Do NOT extract: task steps, transient questions, code findings, or anything already obvious from the current context. Return strict JSON only: {"facts": string[]}, at most 12 facts, each <= 300 chars. If there are none, return {"facts": []}.',
      },
      {
        role: 'user',
        content: `Conversation to scan:\n\n${scan}`,
      },
    ], {
      maxChars: 4000,
      temperature: 0.1,
      enableReasoning: false,
      timeoutMs: 30000,
    });
    const text = (raw || '').trim();
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed || !Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => f.trim().slice(0, 500))
      .slice(0, 12);
  } catch {
    return []; // fail-open: compaction proceeds regardless
  }
}

/**
 * Context compaction: keep system + last N user/assistant turns verbatim,
 * summarize earlier ones (plus their tool results) into a single system message
 * via the LLM. Falls back to naive truncation if the LLM is unavailable or
 * errors. Preserves the leading system messages and any tool results that pair
 * with the retained tail (Anthropic requires every kept assistant tool_use to
 * be followed by its tool_result).
 *
 * Returns null if there are too few messages to compact.
 */
export async function compactMessages(session) {
  const conversation = session.messages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (conversation.length < 6) return null;

  const keep = 4;   // keep the last 4 user/assistant MESSAGES verbatim (not 4 full turns)
  const toCompact = conversation.slice(0, conversation.length - keep);
  const kept = conversation.slice(conversation.length - keep);

  // P0-2 channel 3: before these turns are summarized away, extract durable
  // user-stated facts into the session facts store so they survive
  // independent of the summary. Best-effort: extraction failures are
  // swallowed inside extractCompactedFacts and compaction proceeds. The
  // facts go to the store keyed by the CURRENT transcript session; the
  // standing "## Session facts" message is refreshed by the next turn's
  // ensure pass (this path runs pre-turn, before the injection site).
  try {
    const facts = await extractCompactedFacts(session.llm, toCompact);
    if (facts.length > 0 && session.project?.id && session.transcript?.sessionId) {
      const { addSessionFact } = await import('../../lib/agent/session_facts.js');
      let added = 0;
      for (const f of facts) {
        const out = await addSessionFact(session.project.id, session.transcript.sessionId, f, { source: 'compact-extract' });
        if (Array.isArray(out) && out.length > 0 && added < out.length) added = out.length;
      }
      if (added > 0) {
        await session.transcript?.logMeta('session_facts_extracted', { count: added, source: 'compact-extract' });
      }
    }
  } catch { /* extraction is best-effort; never block compaction */ }

  // IMPORTANT: Anthropic requires every assistant tool_use to be immediately
  // followed by its tool_result. We must NOT drop a `tool` message whose
  // matching assistant tool_calls message is being kept verbatim, or the next
  // call 400s ("tool_use ids found without tool_result blocks"). Collect the
  // tool_call_ids emitted by any kept assistant turn and retain their `tool`
  // results in their original positions among the kept messages.
  const keptToolCallIds = new Set();
  for (const m of kept) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc.id) keptToolCallIds.add(tc.id);
    }
  }

  // Find where the kept tail begins in the full message list so we can carry
  // the trailing `tool` results forward alongside their assistant tool_calls.
  const keptStart = (() => {
    const firstKept = kept[0];
    return session.messages.indexOf(firstKept);
  })();

  // Classify the leading (pre-keptStart) system messages so compaction is
  // self-stabilizing across repeated auto-compacts, instead of stacking one
  // overlapping summary on top of another:
  //   - PRESERVE verbatim: the main system prompt + any other standing system
  //   messages (these carry persistent instructions, not turn-scoped state).
  //   - FOLD into the summary: a prior compaction's `## Prior conversation
  //   (compacted)` summary (it is superseded once re-summarized alongside
  //   the newer turns) and every turn-scoped `## Knowledge-base context for
  //   this turn` injection (those are stale by definition once their turn is
  //   compacted). Folding keeps the single compressed summary complete.
  const COMPACTED_HDR = '## Prior conversation (compacted)';
  const KBCONTEXT_HDR = '## Knowledge-base context for this turn';
  const foldable = new Set();
  const leadingSystem = [];
  if (keptStart >= 0) {
    for (let i = 0; i < keptStart; i++) {
      const m = session.messages[i];
      if (m.role !== 'system') continue;
      leadingSystem.push(m);
      const c = typeof m.content === 'string' ? m.content : '';
      if (c.startsWith(COMPACTED_HDR) || c.startsWith(KBCONTEXT_HDR)) {
        foldable.add(m);
      }
    }
  }

  // Collect the tool results that pair with the compacted (dropped) assistant
  // turns. They carry the real file/bash/KB output and must be fed to the
  // summarizer rather than silently discarded.
  const compactedToolResults = [];
  if (keptStart >= 0) {
    for (let i = 0; i < keptStart; i++) {
      const m = session.messages[i];
      if (m.role === 'tool' && m.tool_call_id && !keptToolCallIds.has(m.tool_call_id)) {
        compactedToolResults.push(m);
      }
    }
  }

  // Merge the compacted user/assistant turns with their tool results AND any
  // foldable leading system messages (prior summaries + stale per-turn KB
  // context), in their original conversation order.
  const toSummarize = [...toCompact, ...compactedToolResults, ...leadingSystem.filter(m => foldable.has(m))].sort((a, b) => {
    const ia = session.messages.indexOf(a);
    const ib = session.messages.indexOf(b);
    return (ia < 0 ? 0 : ia) - (ib < 0 ? 0 : ib);
  });

  let summaryText = null;
  if (session.llm) {
    try {
      summaryText = await summarizeConversation(session.llm, toSummarize);
    } catch {
      summaryText = null;
    }
  }
  if (!summaryText) {
    // Naive fallback: concatenate + truncate, now including tool results so we
    // don't silently drop them.
    summaryText = toSummarize
      .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');
  }

  // Build a fresh message list: leading standing system messages (the main
  // system prompt etc.), the new summary, then the kept tail WITH its matching
  // tool results preserved. Foldable leading system messages (prior
  // compaction summaries + stale per-turn KB context) are NOT copied verbatim
  // — they were folded into the summary above, so the compressed history stays
  // a single coherent block instead of stacking across repeated compactions.
  // `tool` messages before keptStart are likewise dropped (summarized above).
  const newMessages = [];
  for (let i = 0; i < (keptStart >= 0 ? keptStart : session.messages.length); i++) {
    const m = session.messages[i];
    if (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') continue;
    if (foldable.has(m)) continue;  // superseded by the new summary below
    newMessages.push(m);
  }
  newMessages.push({
    role: 'system',
    content: `## Prior conversation (compacted)\nThe following is a summary of the previous ${toCompact.length} messages (and their tool results). Treat it as background context.\n\n${summaryText.slice(0, 12000)}${summaryText.length > 12000 ? '...(truncated)' : ''}\n`,
  });
  if (keptStart >= 0) {
    for (let i = keptStart; i < session.messages.length; i++) {
      const m = session.messages[i];
      // Keep every kept user/assistant turn verbatim, plus any `tool` result
      // that pairs with a retained assistant tool_call. Drop `tool` results
      // whose caller was compacted away (those are summarized above instead).
      if (m.role === 'tool') {
        if (m.tool_call_id && keptToolCallIds.has(m.tool_call_id)) newMessages.push(m);
        continue;
      }
      if (m.role === 'user' || m.role === 'assistant') newMessages.push(m);
    }
  }

  return { messages: newMessages, dropped: toCompact.length, kept: kept.length };
}

/**
 * Auto context compaction (HK2_ENABLE_AUTOCOMPACT, default 1 since the
 * session-facts layer landed): if the last measured context size reached
 * HK2_AUTOCOMPACT_PCTUSED% (default 90) of the model's context window,
 * compact the prior conversation at the turn boundary so an in-flight turn
 * is never interrupted.
 *
 * The default flipped 0 → 1 because the two loss channels that made
 * auto-compaction risky are now closed: (a) durable user-stated facts are
 * extracted into the session facts store BEFORE the turns are summarized
 * away (and survive as a standing system message), and (b) the summarizer
 * input is head+tail so opening-stated facts reach the summary verbatim.
 * The alternative to auto-compaction — letting the provider hard-truncate
 * or error at the window edge — loses the SAME information with no summary
 * and no extraction at all.
 *
 * Runs only at the start of a new turn (before rewrite/retrieval/agent work),
 * using the snapshot captured at the previous turn's end. The tolerance comes
 * from only checking at this safe boundary — never mid-loop.
 */
export async function maybeAutoCompact(session, ctx) {
  if (!envFlag('HK2_ENABLE_AUTOCOMPACT', 1)) return;
  const windowTokens = session.modelCfg?.maxChars || 0;
  if (!windowTokens) return;

  const pctUsed = envPercent('HK2_AUTOCOMPACT_PCTUSED', 90);
  const threshold = Math.floor(windowTokens * pctUsed / 100);
  const current = session.lastContextTokens || estimateMessagesTokens(session.messages);
  if (current < threshold) return;

  const preEstimate = estimateMessagesTokens(session.messages);
  const out = await compactMessages(session);
  if (!out) return;

  session.messages = out.messages;
  // Calibrated post-compact estimate (vs the raw chars/4 guess): keeps the
  // status bar truthful after compaction and keeps the NEXT threshold check
  // on the same scale as the real measurements it is compared against.
  applyCompactTokenEstimate(session, preEstimate);
  await session.transcript?.logMeta('auto-compact', {
    beforeTokens: current,
    afterTokens: session.lastContextTokens,
    threshold,
    pctUsed,
    dropped: out.dropped,
    kept: out.kept,
  });
  ctx.print(`[auto-compact] context ${fmtTok(current)} ≥ ${fmtTok(threshold)} (${pctUsed}% of ${fmtTok(windowTokens)}) → compacted ${out.dropped} messages, kept ${out.kept}.`);
}

// Note: bash search detection lives in lib/agent/tools.js's KbFirstGuard
// (_isBashSearch). The turn pipeline calls it via session.kbGuard for the
// end-of-turn KB-update suggestion.

/**
 * After a turn ends, if the agent used bash to grep/find/cat source files
 * (i.e. the KB didn't have what it needed), offer to update the three KB
 * spaces per their update policies:
 *
 *   Index Space  — auto with HK2_ENABLE_AUTOUPDATEKB=1; otherwise prompt y/N
 *   Eden Space   — auto with HK2_ENABLE_AUTO_LEARN=1;  otherwise prompt y/N
 *   Holy Space   — ALWAYS prompt y/N, regardless of env vars
 *
 * Why: Holy holds stable design knowledge; committing to it is a deliberate
 * user choice. Eden and Index can be auto-updated because their content is
 * either derivable (Index: re-derived from code) or transient (Eden: lists
 * that evolve with the codebase).
 */
export async function maybeOfferKbUpdate(session, ctx) {
  if (!session.project) return;
  if (!session.bashSearchCommands || session.bashSearchCommands.length === 0) return;

  const autoUpdate = envFlag('HK2_ENABLE_AUTOUPDATEKB', 0);
  const autoLearn = envFlag('HK2_ENABLE_AUTO_LEARN', 0);

  ctx.print('');
  ctx.print(`[kb hint] The agent used bash to search source files ${session.bashSearchCommands.length} time(s) during this turn.`);
  ctx.print('          This usually means the KB was missing some knowledge the agent needed.');

  // 1. Index Space — re-index the code
  if (autoUpdate) {
    await runKbUpdate(session, ctx);
  } else {
    const ok = await ctx.confirm('Run /kb update now to refresh the derived index and synchronize parser-owned document entries? (y/N) ', { title: 'Update index' });
    if (ok) await runKbUpdate(session, ctx);
    else ctx.print('[kb hint] Skipped KB refresh. Run /kb update manually when ready.');
  }

  // 2. Eden / Holy — ask the model to extract what it learned, then route
  //    to the right space based on stability. The model itself decides
  //    whether the learned content is "stable" (Holy) or "frequently-updated"
  //    (Eden). Per-space policy then applies:
  //      - Eden + HK2_ENABLE_AUTO_LEARN=1 → auto-commit
  //      - Eden + HK2_ENABLE_AUTO_LEARN=0 → prompt y/N
  //      - Holy → ALWAYS prompt y/N (even with auto-learn)
  //    SKIPPED when the agent already saved knowledge via kb_save_knowledge
  //    this turn (or the user explicitly declined a proposal) — re-running
  //    the extraction would duplicate what was just learned. A session-level
  //    cooldown additionally covers follow-up turns of the same task and
  //    --resume'd sessions.
  if (session.kbSavedThisTurn) {
    const savedPart = session.kbSavedEntries.length > 0
      ? ` (${session.kbSavedEntries.map(e => `${e.space}:${e.id}`).join(', ')})`
      : '';
    const declinedPart = session.kbSavedEntries.length > 0
      ? ''
      : ' (you declined the proposal, nothing was written)';
    ctx.print(`[kb learn] skipped — knowledge was already captured via kb_save_knowledge this turn${savedPart}${declinedPart}.`);
    ctx.print('            Run /kb knowledge learn manually if you want a deeper study.');
    session.kbLearnHandledAt = Date.now();
  } else if (kbLearnInCooldown(session)) {
    ctx.print(`[kb learn] skipped — this session's knowledge was captured/answered ${Math.floor((Date.now() - session.kbLearnHandledAt) / 60000)} min ago (within the learn cooldown you enabled via HK2_KB_LEARN_COOLDOWN_MIN; unset it or set 0 to always ask).`);
    ctx.print('            Run /kb knowledge learn manually if you want a deeper study.');
  } else {
    await learnNewKnowledge(session, ctx, { autoLearn });
  }

  session.bashSearchCommands = [];
}

/**
 * Holy-over-Eden priority: end-of-task Eden sync.
 *
 * For every conflict recorded this turn (session.kbConflicts, populated by
 * the turn pipeline right after buildRequestGraph), stamp the Eden entry with
 * supersededBy = "holy:<id>" and prepend a supersession notice to its intro
 * so future readers know Holy is authoritative. Eden is the auto-updatable
 * space, so this runs WITHOUT a per-entry prompt (per the priority rule:
 * "以Holy为准 + 更新Eden + 提醒用户"); the final print is the reminder.
 * Best-effort: a failed write warns and continues to the next entry.
 *
 * Exported for unit tests (test/holy-eden-priority.test.js covers the tool
 * layer; this one is exercised via test/kb-priority-sync.test.js).
 */
export async function syncConflictingEden(session, ctx) {
  const conflicts = session.kbConflicts || [];
  if (conflicts.length === 0) return;
  if (!session.project || !session.rt) return;
  const projectId = session.project.id;
  const { readKnowledge, writeKnowledge } = await import('../../lib/store/kb_store.js');
  const synced = [];
  const failed = [];
  for (const c of conflicts) {
    if (!c?.eden?.id) continue;
    try {
      const entry = await readKnowledge(projectId, 'eden', c.eden.id);
      if (!entry) continue; // already deleted / moved — nothing to sync
      if (entry.supersededBy === `holy:${c.holy.id}`) { synced.push(c); continue; } // idempotent
      const updated = {
        ...entry,
        supersededBy: `holy:${c.holy.id}`,
        supersededAt: new Date().toISOString(),
        intro: `[Superseded by holy:${c.holy.id} — Holy Space takes precedence; follow the Holy entry "${c.holy.title}" instead.]\n\n${entry.intro || ''}`,
      };
      await writeKnowledge(projectId, 'eden', updated);
      const fresh = await readKnowledge(projectId, 'eden', c.eden.id);
      if (fresh) session.rt.reloadKnowledge?.(fresh, 'eden');
      synced.push(c);
    } catch (err) {
      failed.push({ c, err });
    }
  }
  session.kbConflicts = [];
  if (synced.length > 0) {
    ctx.print('');
    ctx.print(`${style.warning(style.ICON.warn + ' [kb priority]')} synced ${synced.length} Eden entr${synced.length === 1 ? 'y' : 'ies'} superseded by Holy:`);
    for (const c of synced) {
      ctx.print(`  - eden "${c.eden.title}" (${c.eden.id}) → supersededBy holy:${c.holy.id}`);
    }
    ctx.print(style.dim('  Eden entries keep their content but are marked superseded; Holy remains authoritative. Use /kb transform to move or /kb knowledge delete to remove them.'));
    await session.transcript?.logMeta('kb_priority_sync', {
      synced: synced.map(c => ({ eden: c.eden.id, holy: c.holy.id })),
    }).catch(() => {});
  }
  for (const { c, err } of failed) {
    ctx.print(`${style.warning('[kb priority]')} failed to sync eden "${c.eden.id}": ${err.message}`);
  }
}

/**
 * Cooldown gate for the end-of-turn [kb learn] fallback. Returns true when a
 * knowledge capture was handled recently enough that re-extracting the same
 * task would be redundant. OFF by default (0): the end-of-turn prompt always
 * reaches the user unless a positive window is explicitly configured — the
 * user, not a timer, decides when learning is done. The cooldown window is
 * memoized on the session so tests can override it deterministically.
 */
function kbLearnInCooldown(session) {
  const minutes = Number.parseFloat(String(process.env.HK2_KB_LEARN_COOLDOWN_MIN ?? '0').trim());
  const ms = (Number.isFinite(minutes) ? minutes : 0) * 60_000;
  session.kbLearnCooldownMs = ms;
  if (!Number.isFinite(minutes) || ms <= 0) return false;
  if (!session.kbLearnHandledAt || session.kbLearnHandledAt <= 0) return false;
  return Date.now() - session.kbLearnHandledAt < ms;
}

async function runKbUpdate(session, ctx) {
  ctx.print('[kb update] refreshing derived index + syncing parser-owned doc entries (incremental)...');
  try {
    const { buildIndex } = await import('../../lib/index/indexer.js');
    const { markKbBuilt } = await import('../../lib/config/home.js');
    const { dropRuntime } = await import('../../lib/retrieval/kb_runtime.js');
    // Legacy-KB upgrade check: fix stale layout signals losslessly before the
    // incremental re-index (same flow as /kb update and --mode=update-kb).
    let full = false;
    try {
      const { migrateKb } = await import('../../lib/store/kb_migrate.js');
      const migration = await migrateKb(session.project.id);
      if (migration.error) {
        ctx.print(`[kb update] upgrade aborted: ${migration.error}`);
        return false;
      }
      if (migration.needed) {
        ctx.print('[kb update] legacy KB detected — upgrading to the current layout:');
        for (const it of migration.items) ctx.print(`  - ${it.id}: ${it.reason}`);
        for (const line of migration.performed || []) ctx.print(`  + ${line}`);
        if (migration.backupDir) ctx.print(`  + knowledge snapshot: ${migration.backupDir}`);
        full = !!migration.fullRebuild;
        if (full) ctx.print('  + parser format changed — full re-index will follow');
      }
    } catch (err) {
      ctx.print(`[kb update] upgrade check failed (continuing with normal update): ${err.message}`);
    }
    const stats = await buildIndex(session.project.id, { full });
    await markKbBuilt(session.project.id);
    dropRuntime(session.project.id);
    ctx.print(`[kb update] done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
    ctx.noteReloadKb?.();
    return true;
  } catch (err) {
    ctx.print(`[kb update] failed: ${err.message}`);
    return false;
  }
}

/**
 * End-of-turn Code Review (HK2_ENABLE_CODEREVIEW, default 0). Runs after the
 * agent finishes executing a plan and the plan block has been finalized. It
 * collects the working-tree result (diff + changed files) and the final answer,
 * reviews them with a configurable phase model
 * (`/model set-phase --phase=code-review`), and prints any issues one-by-one.
 * Best-effort: any failure is reported and the turn ends normally.
 *
 * Renders through the turn `ui` (streaming, spinner, phase) — UI-agnostic.
 */
export async function runCodeReview(session, ctx, ui, { planText, assistantText, resolvePhaseLlm, signal }) {
  if (!session.llm) return;

  // Resolve a per-phase model override for the code-review phase; fall back to
  // the session model when unset or unresolvable (matching plan-review).
  let reviewLlm = session.llm;
  let usingPhaseModel = false;
  try {
    const phaseLlm = await resolvePhaseLlm('code-review');
    if (phaseLlm) { reviewLlm = phaseLlm; usingPhaseModel = true; }
  } catch (err) {
    ctx.print(`[warn] could not resolve phase model for code-review, using session model: ${err.message}`);
  }

  const reviewModelLabel = usingPhaseModel
    ? (getPhaseModelRef(session.project, 'code-review') || 'code-review phase model')
    : 'session model';

  // Explicitly show that a Code Review is running AND what it is reviewing.
  ctx.print('');
  ctx.print(style.accent(style.bold('Code Review')));
  ctx.print(style.dim(`  Reviewing the completed plan result with ${reviewModelLabel}...`));
  ctx.print(style.dim('  Checks: correctness, completeness, quality, and consistency of the changes.'));

  // Collect the result of the execution: the working-tree diff + changed files.
  const { diffText, changedFiles } = await collectWorkingTreeDiff(session.project?.sourcePath);
  ctx.print(style.dim(
    changedFiles.length > 0
      ? `  Files changed (${changedFiles.length}): ${changedFiles.slice(0, 12).join(', ')}${changedFiles.length > 12 ? '...' : ''}`
      : '  Files changed: (none detected - reviewing the plan and final answer only)'
  ));

  // Show a live "review in progress" indicator while the LLM review runs.
  // ui.progress.done() has already run for the agent loop, so restart the spinner
  // for this phase and pause it before printing the result (mirroring the
  // plan-review UX). In non-TTY mode ProgressIndicator prints a one-line phase
  // header instead, which keeps the wait visible in piped runs too.
  let started = false;
  try {
    ui.progress.nextPhase('reviewing code');
    started = true;
    ui.setPhaseSafe('reviewing code');
  } catch { /* progress already finalized - status bar still shows the phase */ }

  try {
    const reviewText = buildCodeReviewContent({
      planText: planText || '',
      changedFiles,
      diffText,
      answerText: assistantText || '',
    });
    // Stream the reviewer's analysis live, mirroring the agent loop's own
    // streaming UX: progress.tick() clears the spinner on the first delta,
    // MarkdownStream styles headings/lists/code as they arrive. The verdict
    // filter hides the machine-readable JSON that follows the === VERDICT ===
    // marker so the user never sees raw JSON scrolling by. The reviewer's
    // THINKING stream renders live too (ReasoningStream + progress.reason(),
    // mirroring the main agent loop): reasoning deltas arrive before any body
    // text, so without this the whole deep-reasoning window is a silent
    // spinner.
    ui.stream.reset();
    // Write any partial line the renderer is still holding so subsequent
    // prints (warnings, verdict) always start on a fresh line.
    const flushNow = () => ui.stream.flush();
    const onReasoning = (text) => {
      ui.progress.reason();
      ui.stream.reasoning(text, 'shown');
    };
    const onDelta = createVerdictFilter((text) => ui.stream.delta(text));
    // Review phases use the "skip on unreachable" policy — NEVER a session-
    // model fallback (see runPhaseWithSkipOnUnreachable): substituting an
    // unplanned model would change what reviewed the code. Warnings are
    // printed by the policy; skip -> no "no issues found" message, the turn
    // simply ends without a review.
    const reviewRun = await runPhaseWithSkipOnUnreachable({
      phase: 'code-review',
      phaseLlm: usingPhaseModel ? reviewLlm : null,
      sessionLlm: session.llm,
      warn: (m) => { flushNow(); ui.progress.breakLine(); ctx.print(m); },
      run: (llmForReview) => reviewCode(llmForReview, reviewText, { signal, onDelta, onReasoning }),
    });
    // Flush the stream renderer's trailing partial line before the verdict.
    flushNow();
    await session.transcript?.logMeta('codeReview', {
      skipped: reviewRun.skipped,
      ...(reviewRun.skipped ? { error: reviewRun.error } : {}),
      ok: reviewRun.result ? reviewRun.result.ok : null,
      issueCount: reviewRun.result && reviewRun.result.issues ? reviewRun.result.issues.length : 0,
      ...(reviewRun.result && reviewRun.result.parseError ? { parseError: reviewRun.result.parseError } : {}),
      changedFileCount: changedFiles.length,
      phaseModelRef: usingPhaseModel && !reviewRun.skipped ? (getPhaseModelRef(session.project, 'code-review') || null) : null,
    });

    if (reviewRun.skipped) {
      // Model unreachable: warnings already printed; end without a review.
    } else if (reviewRun.result.parseError) {
      // The reply had no parseable JSON verdict: UNKNOWN outcome, never
      // "no issues found". Whatever the reviewer said already streamed above.
      ctx.print(style.warning(`  [warn] ${reviewRun.result.parseError} - the review outcome is UNKNOWN.`));
    } else if (reviewRun.result.ok || !reviewRun.result.issues || reviewRun.result.issues.length === 0) {
      ctx.print(style.dim('  Code review complete - no issues found.'));
    } else {
      ctx.print(style.warning(`  Code review found ${reviewRun.result.issues.length} issue(s):`));
      reviewRun.result.issues.forEach((issue, i) => {
        ctx.print('');
        ctx.print(style.warning(style.bold(`  Issue ${i + 1}: ${issue.title}`)));
        if (issue.detail) ctx.print(style.dim(`    ${issue.detail}`));
        if (issue.suggestion) ctx.print(`    ${style.bold('Suggestion:')} ${issue.suggestion}`);
      });
    }
  } catch (err) {
    ctx.print(`[warn] code review failed: ${err.message}`);
  } finally {
    if (started) {
      try { ui.progress.pause(); } catch { /* ignore */ }
    }
    ui.setPhaseSafe('idle');
  }
}

/**
 * One-shot LLM call to extract a knowledge entry from the just-finished
 * conversation. The model itself decides whether the content belongs in
 * Holy Space (stable) or Eden Space (frequently-updated). Per-space policy
 * then decides whether to auto-commit or prompt the user.
 *
 * Holy ALWAYS prompts the user — even with HK2_ENABLE_AUTO_LEARN=1.
 */
export async function learnNewKnowledge(session, ctx, { autoLearn }) {
  if (!session.llm) {
    ctx.print('[kb learn] no LLM available, skipping knowledge capture.');
    return;
  }
  const lastUser = [...session.messages].reverse().find(m => m.role === 'user');
  const lastAssistant = [...session.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string');
  if (!lastUser || !lastAssistant) {
    ctx.print('[kb learn] no conversation to learn from, skipping.');
    return;
  }

  ctx.print('[kb learn] asking the model to summarize what it learned...');
  ctx.print(style.dim('          (one LLM call, up to ~1 min; you will be asked y/N before anything is written)'));

  const sysPrompt = `You are extracting a reusable knowledge note from a completed coding task so future tasks on the same project can skip the discovery work.

The project KB has two knowledge spaces:
- "holy": stable knowledge that rarely changes (design principles, key algorithms, fundamental patterns). Examples: "how to write a PostgreSQL extension", "how the WAL replay loop works".
- "eden": frequently-updated knowledge (function lists, command catalogs, observed patterns that may evolve). Examples: "list of common SQL commands", "frequently-used utility functions".

Output STRICT JSON only — no markdown fences, no prose. Schema:
{
  "space": "holy" | "eden",
  "id": "kebab-case-id",
  "title": "human-readable title",
  "intro": "2-5 paragraphs of prose explaining the concept; include key API names and call patterns",
  "keyFiles": ["project-relative file paths"],
  "keySymbols": ["exact function/type names"],
  "keywords": ["english keywords for future search"]
}

Pick "holy" only for genuinely stable design knowledge. Pick "eden" for things that may evolve.
The id "hk2-supreme-code" is reserved for the project's permanent Supreme Code — never propose it.
If the conversation did not produce any reusable knowledge (one-off fix, trivial), output: {"skip": true}`;

  const userPrompt = `Task that was just completed:
USER: ${typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)}

Bash search commands the agent used during this task (signaling KB gaps):
${session.bashSearchCommands.slice(0, 8).map(c => '- ' + c.split('\n')[0].slice(0, 200)).join('\n')}

Agent's final summary / explanation:
${(typeof lastAssistant.content === 'string' ? lastAssistant.content : '').slice(0, 4000)}`;

  let raw = '';
  for await (const evt of session.llm.stream(
    [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.1, maxChars: 8192, enableReasoning: false, timeoutMs: 60000 },
  )) {
    if (evt.type === 'delta') raw += evt.text;
  }

  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed || parsed.skip) {
    ctx.print('[kb learn] the model declined to save a knowledge entry (no reusable knowledge identified).');
    // The extraction ran and concluded there is nothing to save — re-running
    // it for follow-up turns of the same task would just burn another minute.
    session.kbLearnHandledAt = Date.now();
    return;
  }

  const space0 = parsed.space === 'eden' ? 'eden' : 'holy';
  let space = space0;
  let id = String(parsed.id || 'learned').replace(/[^A-Za-z0-9_.-]/g, '_');
  // The supreme-code entry is permanent and managed ONLY via /kb code add|del.
  // The learn flow must never overwrite it — not even with user confirmation.
  {
    const { isSupremeCode } = await import('../../lib/store/supreme_code.js');
    if (isSupremeCode(id)) {
      ctx.print('[kb learn] refused: "hk2-supreme-code" is the permanent Supreme Code entry — manage it via /kb code add | /kb code del.');
      session.kbLearnHandledAt = Date.now();
      return;
    }
  }
  const record = {
    id,
    space,
    title: parsed.title || 'Learned knowledge',
    intro: parsed.intro || '',
    keyFiles: Array.isArray(parsed.keyFiles) ? parsed.keyFiles : [],
    keySymbols: Array.isArray(parsed.keySymbols) ? parsed.keySymbols : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    autoLearned: true,
  };

  // ================= Validation against the existing KB =================
  // Before any write, check the KB for (a) the same meaning (skip — no
  // re-learning), (b) a related entry this knowledge should UPDATE in
  // place (merge onto it), (c) a direct contradiction (conflict — Holy
  // conflicts are ALWAYS decided by the user; Eden conflicts follow the
  // validator's winner + stated reason), or (d) nothing related (new —
  // when related entries exist, state why we are NOT updating them).
  // Best-effort: any validation failure falls through as 'new' so the
  // normal per-space confirmation path still runs. Gate:
  // HK2_KB_LEARN_VALIDATE (default on, set 0 to disable).
  let preApproved = false;
  let validateInfo = null;
  if (envFlag('HK2_KB_LEARN_VALIDATE', 1)) {
    const { listKnowledge } = await import('../../lib/store/kb_store.js');
    const { findCandidateEntries, validateLearnedEntry } = await import('../../lib/agent/kb_validate.js');
    const { isSupremeCode } = await import('../../lib/store/supreme_code.js');
    const holyList = await listKnowledge(session.project.id, 'holy').catch(() => []);
    // Eden entries stamped supersededBy="holy:*" are RETIRED (Holy takes
    // precedence — the same exclusion buildRequestGraph applies). Never merge
    // onto or conflict with a retired entry: writing it back would silently
    // strip the stamp and resurrect it into retrieval.
    const edenList = (await listKnowledge(session.project.id, 'eden').catch(() => []))
      .filter(e => !e.supersededBy);
    const candidates = findCandidateEntries(record, holyList, edenList);
    if (candidates.length > 0) {
      ctx.print('');
      ctx.print(style.dim(`[kb learn validate] ${candidates.length} related entr${candidates.length === 1 ? 'y' : 'ies'} found (${candidates.slice(0, 3).map(c => `${c.space}:${c.entry.id}`).join(', ')}${candidates.length > 3 ? ' ...' : ''}) — validating...`));
    }
    const verdict = await validateLearnedEntry(session.llm, record, candidates, { timeoutMs: 60000 });
    validateInfo = { validation: verdict.verdict, validatedAgainst: verdict.targetId };

    if (verdict.verdict === 'duplicate') {
      // Same or essentially the same meaning already in the KB — skip the
      // write entirely to avoid duplicate learning.
      ctx.print(`[kb learn] skipped — the KB already contains the same knowledge ("${verdict.targetId}").`);
      ctx.print(`  reason: ${verdict.reason || '(not provided)'}`);
      session.kbLearnHandledAt = Date.now();
      return;
    }

    const cand = candidates.find(c => c.entry.id === verdict.targetId);
    if (cand && isSupremeCode(cand.entry.id)) {
      // The permanent Supreme Code entry can never be a merge/conflict
      // target: a redirected write would drop its `codes` array and the
      // protected flags. Managed ONLY via /kb code add | /kb code del.
      ctx.print(`[kb learn] refused: the validator targeted "${cand.entry.id}" — that is the permanent Supreme Code entry, managed only via /kb code add | /kb code del.`);
      session.kbLearnHandledAt = Date.now();
      return;
    }

    if (verdict.verdict === 'update' && cand) {
      // Related entry covers the same topic — merge onto it instead of
      // creating a near-identical sibling. The write keeps the existing
      // entry's id + space; createdAt is carried over explicitly below
      // (writeKnowledge only preserves it when the record already has one).
      ctx.print(`[kb learn validate] "${verdict.targetId}" covers the same topic — merging into it instead of creating a sibling entry.`);
      ctx.print(`  reason: ${verdict.reason || '(not provided)'}`);
      id = cand.entry.id;
      record.id = cand.entry.id;
      space = cand.space;
      record.space = cand.space;
      record.title = cand.entry.title || record.title;
      record.intro = verdict.mergedIntro;
      record.createdAt = cand.entry.createdAt; // keep the original creation time
      record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place merge must not reset the space-change time
      record.keywords = [...new Set([...(cand.entry.keywords || []), ...record.keywords])];
      record.keyFiles = [...new Set([...(cand.entry.keyFiles || []), ...record.keyFiles])];
      record.keySymbols = [...new Set([...(cand.entry.keySymbols || []), ...record.keySymbols])];
      record.updatedByLearn = true;
    } else if (verdict.verdict === 'conflict' && cand) {
      // Direct contradiction with an existing entry.
      ctx.print(`${style.warning(style.ICON.warn + ' [kb learn validate]')} the new entry CONFLICTS with ${cand.space}:"${verdict.targetId}":`);
      ctx.print(`  existing: ${(cand.entry.intro || '').replace(/\s+/g, ' ').slice(0, 160)}${(cand.entry.intro || '').length > 160 ? '...' : ''}`);
      ctx.print(`  proposed: ${(record.intro || '').replace(/\s+/g, ' ').slice(0, 160)}${(record.intro || '').length > 160 ? '...' : ''}`);
      ctx.print(`  validator verdict: ${verdict.conflictWinner === 'new' ? 'the NEW entry wins' : 'the EXISTING entry wins'}. reason: ${verdict.reason || '(not provided)'}`);
      if (cand.space === 'holy') {
        // Holy conflicts are ALWAYS decided by the user — Holy Space is
        // the source of truth and every write needs explicit approval.
        const apply = await ctx.confirm(`Update holy entry "${verdict.targetId}" with the new knowledge (new wins)? (y/N) `, { title: 'Update knowledge' });
        if (!apply) {
          ctx.print('[kb learn] skipped — keeping the existing Holy entry (original wins).');
          session.kbLearnHandledAt = Date.now();
          return;
        }
        id = cand.entry.id;
        record.id = cand.entry.id;
        space = 'holy';
        record.space = 'holy';
        record.title = cand.entry.title || record.title;
        record.createdAt = cand.entry.createdAt; // keep the original creation time
        record.spaceChangedAt = cand.entry.spaceChangedAt; // in-place update: keep the original space-change time
        record.updatedByLearn = true;
        validateInfo.conflictResolvedBy = 'user';
        preApproved = true; // the user just approved this exact write
      } else if (verdict.conflictWinner === 'existing') {
        ctx.print('[kb learn] skipped — the existing entry wins the conflict (the new extraction looked stale or wrong).');
        session.kbLearnHandledAt = Date.now();
        return;
      } else {
        // Eden-vs-Eden, new wins: write the new entry and surface the old
        // one for manual cleanup (no auto-supersede across eden entries).
        ctx.print(`  The new entry is written; the contradicting eden entry "${verdict.targetId}" is kept — review it with /kb knowledge show and remove via /kb knowledge del if stale.`);
      }
    } else if (candidates.length > 0) {
      // verdict new, but related entries exist — state why we are NOT
      // updating them (required explanation for not updating in place).
      ctx.print(style.dim(`[kb learn validate] creating a NEW entry — not updating the related entr${candidates.length === 1 ? 'y' : 'ies'} (${candidates.slice(0, 3).map(c => `${c.space}:${c.entry.id}`).join(', ')}).`));
      ctx.print(style.dim(`  reason: ${verdict.reason || '(no reason provided)'}`));
    }
  }

  // Per-space policy
  let commit = false;
  if (space === 'holy') {
    if (preApproved) {
      // Conflict path: the user already approved this exact write above.
      commit = true;
    } else {
    // Holy ALWAYS prompts — even with HK2_ENABLE_AUTO_LEARN=1.
    // y/N/E tri-state (per the KB-priority rule): E saves this NEW entry to
    // Eden instead of Holy. Only offered when the id does NOT already exist
    // in Holy (an update keeps the plain y/N contract — same as
    // toolKbSaveKnowledge).
    const { readKnowledge: rk } = await import('../../lib/store/kb_store.js');
    const existingHoly = await rk(session.project.id, 'holy', id).catch(() => null);
    const isNewHoly = !existingHoly;
    ctx.print('');
    ctx.print(`[kb learn] Model proposes HOLY entry "${id}": ${record.title}`);
    ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
    ctx.print(`  Note: Holy Space is the stable source of truth. Updates require explicit approval even with HK2_ENABLE_AUTO_LEARN=1.`);
    let answer;
    if (isNewHoly) {
      ctx.print(style.dim('  E = save this entry to Eden space instead of Holy.'));
      // Prefer the ctx-owned tri-state prompt (modal under the TUI); fall
      // back to the readline implementation for bare/mock ctx objects.
      const askThreeWay = ctx.confirmThreeWay || ((t) => confirmThreeWay(session, t));
      answer = await askThreeWay(`Commit "${id}" to Holy Space? (y/N/E) `);
    } else {
      answer = await ctx.confirm(`Commit to Holy Space? (y/N) `, { title: 'Save knowledge' });
    }
    if (answer === 'eden') {
      // Redirect to Eden without re-confirming — the user's single answer IS
      // the approval for the Eden write (same contract as knowledgeConfirm).
      space = 'eden';
      record.space = 'eden';
      commit = true;
      ctx.print(style.accent('  Redirected — saving to Eden space instead.'));
    } else {
      commit = answer === true;
    }
    } // end non-preApproved holy path
  } else {
    // Eden: auto-commit if autoLearn, else prompt
    if (autoLearn) {
      commit = true;
    } else {
      ctx.print('');
      ctx.print(`[kb learn] Model proposes EDEN entry "${id}": ${record.title}`);
      ctx.print(`  intro (preview): ${(record.intro || '').slice(0, 200)}${(record.intro || '').length > 200 ? '...' : ''}`);
      commit = await ctx.confirm(`Commit to Eden Space? (y/N) `, { title: 'Save knowledge' });
    }
  }

  if (!commit) {
    ctx.print('[kb learn] Cancelled. Nothing was written.');
    // The user SAW the proposal and declined — treat as handled so follow-up
    // turns don't re-prompt for the same knowledge.
    session.kbLearnHandledAt = Date.now();
    return;
  }

  // Persist
  const { writeKnowledge } = await import('../../lib/store/kb_store.js');
  const p = await writeKnowledge(session.project.id, space, record);
  // Reload into runtime so subsequent kb_knowledge / kb_search_knowledge sees it
  const { readKnowledge } = await import('../../lib/store/kb_store.js');
  const final = await readKnowledge(session.project.id, space, id);
  if (final) session.rt?.reloadKnowledge?.(final, space);

  ctx.print(`[kb learn] saved ${space} entry "${id}": ${record.title}`);
  ctx.print(`            path: ${p}`);
  session.kbLearnHandledAt = Date.now();
  await session.transcript?.logMeta('learned_knowledge', { id, space, title: record.title, ...(validateInfo || {}) });
}
