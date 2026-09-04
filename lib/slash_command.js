/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。易景科技依照法律法规享有相应的著作权、商标权、专利权等知识产权。
 * 未免疑义，本条所指的"知识产权"是指任何及所有基于 Halo 软件产生的：（a）
 * 版权、商标、商号、域名、与商标和商号相关的商誉、设计和专利；与创新技
 * 术诀窍、商业秘密、保密技术、非技术信息相关的权利；（b）人身权、掩模作
 * 品、署名权和发表权；以及（c）在本协议生效之前已存在或此后出现在世界
 * 任何地方的其他工业产权、专有权、与上述权利的所有续期和延长，无论此类
 * 权利是否已在相关法域的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish or display any part of this software, in any
 * form or by any means. Reverse engineering, disassembly, or
 * decompilation of this software, unless required by law for
 * interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, or applications that
 * could create a risk of personal injury. If you use this software in
 * dangerous applications, then you should be responsible for
 * all appropriate fail-safe, backup, redundancy, and other measures to
 * ensure its safe use. Halo Corporation and its affiliates disclaim any
 * and all liability for any damages caused by the use of this software
 * in dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Slash-command shape recognition — the shared guard used by every surface
 * that asks "is this line a command attempt?".
 *
 * Background: every registered hk2 command name is a single-segment ASCII
 * identifier (`/model`, `/kb`; subcommands are separate tokens, never part of
 * the command name). A leading `/` therefore does NOT by itself imply a
 * command: lines like `/Users/zhangchenxi/Workspace/hk2/xxxx.md已更新，你需要…`
 * (an absolute path glued to prose) must keep flowing to the agent as ordinary
 * user input instead of being swallowed by "Unknown command".
 *
 * The rule below is shape-based and example-agnostic:
 *   - a plausible command head is `/` + single-segment ASCII identifier;
 *   - anything else starting with `/` (internal slashes → paths, non-ASCII →
 *     glued prose, `.`/`~` → file/tilde forms) is ordinary text.
 *
 * This module is pure (no imports) so both `lib/` and `src/` layers can use
 * it without dependency-direction violations.
 */

/** Plausible command head: `/` followed by a single-segment ASCII identifier. */
const SIMPLE_HEAD_RE = /^\/[A-Za-z][A-Za-z0-9_-]*$/;

/** A single-segment ASCII identifier (no leading slash). */
const WORD_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * First whitespace-separated token of a line. Deliberately quote-free — this
 * is a cheap shape check, not shell tokenization; the dispatcher still
 * tokenizes properly afterwards for actual command routing.
 * @param {string} line
 * @returns {string}
 */
function firstToken(line) {
  const m = /^\s*(\S+)/.exec(String(line ?? ''));
  return m ? m[1] : '';
}

/**
 * Does this line look like a slash-COMMAND attempt (as opposed to ordinary
 * text that merely starts with `/`)?
 *
 * Shape rules (example-agnostic; each rule names the input FAMILY it keeps
 * flowing to the agent):
 *   - empty / whitespace-only             → false
 *   - head has an internal `/` (absolute path `/Users/...`, `/tmp/x`)
 *                                         → false (ordinary text)
 *   - head has non-ASCII (CJK prose glued directly after a short token,
 *     e.g. `/foo已更新，…` — CJK needs no surrounding spaces) → false
 *   - head starts `/.` or `/~` (hidden files, tilde paths) → false
 *   - head matches `/[A-Za-z][A-Za-z0-9_-]*` exactly → true
 *
 * @param {string} line
 * @returns {boolean} true = treat as command; false = ordinary agent input
 */
export function looksLikeSlashCommand(line) {
  const head = firstToken(line);
  if (!head) return false;
  return SIMPLE_HEAD_RE.test(head);
}

/**
 * Is `name` (with or without leading `/`) a syntactically plausible command
 * name — a single-segment ASCII identifier? Used by the dispatcher to choose
 * between "did you mean" correction and plain "unknown command" feedback.
 */
export function isPlausibleCommandName(name) {
  let s = String(name ?? '');
  if (s.startsWith('/')) s = s.slice(1);
  return WORD_RE.test(s);
}

/**
 * Closest registered command for a misspelled head (prefix match wins, else
 * Levenshtein distance ≤ maxDist, smallest distance wins). Returns the full
 * name with slash, or null when nothing is close.
 *
 * Prints `did you mean '/model'?` when the head was shaped like a command
 * but unregistered — the opposite failure mode of the path-swallowing bug:
 * users typing `/mdoel` still get actionable feedback instead of silence.
 */
export function suggestCommand(misspelled, names, maxDist = 2) {
  const word = String(misspelled ?? '').replace(/^\//, '');
  if (!word) return null;
  let best = null;
  let bestDist = Infinity;
  for (const raw of names || []) {
    const n = String(raw).replace(/^\//, '');
    if (!n) continue;
    if (n === word) return `/${n}`;
    if (n.startsWith(word)) return `/${n}`;
    const d = levenshtein(word, n, maxDist);
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best !== null && bestDist <= maxDist ? `/${best}` : null;
}

/** Bounded Levenshtein: early-exits with limit+1 once a row minimum exceeds `limit`. */
function levenshtein(a, b, limit) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > limit) return limit + 1;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > limit) return limit + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n];
}
