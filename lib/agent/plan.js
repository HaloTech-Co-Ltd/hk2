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
 * 本协议生效之前已在此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在
 * 相关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. Except as expressly permitted
 * in your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software or
 * in dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in dangerous
 * applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Lightweight complexity heuristics for task triage.
 *
 * NOTE: hk2 no longer runs a separate pre-execution plan-generation /
 * complexity-assessment pass. Planning is now LLM-driven: the system prompt
 * (lib/agent/system_prompt.js :: PLANNING_INSTRUCTIONS) instructs the agent to
 * act as its own triage assistant and call the `plan` tool
 * (lib/agent/tools.js :: toolPlan) when it decides a task is complex enough to
 * warrant a user-confirmed plan. The `plan` tool is the interface that
 * receives the LLM plan decision and surfaces it to the user.
 *
 * The two heuristics below are retained as cheap, dependency-free helpers.
 * They are NOT the decision-maker (regex cannot understand semantic intent -
 * e.g. a chained git workflow says "then" but is routine). They exist for
 * callers that want a quick synchronous guess, and as a reference
 * implementation of the simple/complex signals.
 *
 * Exports:
 *   - isObviouslyTrivial(text): true only for definite-simple tasks.
 *   - needsPlanning(text):      legacy regex heuristic; true for multi-step /
 *                               multi-file / non-trivial tasks.
 */

// Sequencing words imply a multi-step task.
const COMPLEX_SEQ_RE = /\b(then|after that|afterwards|next|finally|firstly|secondly|lastly|first[ ,])\b/i;

// Multi-file / architectural action verbs. Also matches "add a feature" /
// "build a system" phrasings that imply non-trivial work.
const COMPLEX_VERB_RE = /\b(refactor\w*|implement\w*|integrat\w*|migrat\w*|design\w*|architect\w*|rewrit\w*|restructur\w*|extract\w*|overhaul\w*|scaffold\w*|redesign\w*|add\s+(?:a\s+|the\s+)?(?:feature|support|endpoint|command|module)|build\s+(?:a\s+|the\s+)?(?:system|pipeline|framework|module|service))\b/i;

// A numbered or bulleted list in the input signals a multi-part task.
const LIST_RE = /(^|\n)\s*(?:\d+[.)]|[-*+])\s+\S/;

// Trivial-intent leads for short tasks: questions, greetings, quick reads,
// status checks. Used only when the input is already short.
const TRIVIAL_INTENT_RE = /\b(hi|hello|hey|yo|thanks|thank you|help|what(?:'s| is| are| does| was| were)|why|where(?:'s| is| are)|how (?:do|to|can)|can you|could you|would you|explain|show|list|status|version|exit|quit|bye|who)\b/i;

const SIMPLE_WORD_MAX_TINY = 6;   // very terse -> simple regardless of intent
const SIMPLE_WORD_MAX = 12;       // short + trivial intent -> simple
const COMPLEX_WORD_MIN = 20;      // long -> complex regardless of verbs

function countFiles(s) {
  const m = s.match(/\b[\w./-]+\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|rb|php|cs|kt|scala|sql|sh|json|yaml|yml|toml)\b/gi);
  return m ? m.length : 0;
}

/**
 * Decide whether a task is OBVIOUSLY trivial - simple enough that no planning
 * is needed. Returns true only for definite-simple inputs (empty, greetings,
 * terse single reads / questions). Conservative: anything ambiguous returns
 * false so the caller proceeds to a real (LLM) decision. We would rather ask
 * the model than wrongly skip planning on a complex task.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isObviouslyTrivial(text) {
  if (!text || !text.trim()) return true;
  const s = text.trim();
  const words = s.split(/\s+/).filter(Boolean);
  // Very terse inputs with no strong action verb are trivial regardless of intent.
  if (words.length <= SIMPLE_WORD_MAX_TINY && !COMPLEX_VERB_RE.test(s)) return true;
  // Short inputs with a trivial-intent lead (questions / greetings / reads) are trivial.
  if (words.length <= SIMPLE_WORD_MAX && TRIVIAL_INTENT_RE.test(s) && !COMPLEX_VERB_RE.test(s)) return true;
  return false;
}

/**
 * Legacy regex heuristic complexity gate. Returns true for multi-step /
 * multi-file / non-trivial tasks; false for trivial ones. A cheap synchronous
 * guess only - the real triage decision is made by the LLM via the system
 * prompt + `plan` tool.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function needsPlanning(text) {
  if (!text || !text.trim()) return false;
  const s = text.trim();

  // --- Complex signals (any one is sufficient) ---
  if (COMPLEX_SEQ_RE.test(s)) return true;
  if (COMPLEX_VERB_RE.test(s)) return true;
  if (countFiles(s) >= 2) return true;
  if (LIST_RE.test(s)) return true;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= COMPLEX_WORD_MIN) return true;

  // --- Simple signals ---
  if (words.length <= SIMPLE_WORD_MAX_TINY) return false;
  if (words.length <= SIMPLE_WORD_MAX && TRIVIAL_INTENT_RE.test(s)) return false;

  // Ambiguous -> plan (conservative).
  return true;
}

export default needsPlanning;
