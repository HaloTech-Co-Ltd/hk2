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
 * Plan generation: use the LLM to decompose a task into an ordered list of
 * steps, each with multiple candidate strategies. Drives the interactive
 * "plan mode" (HK2_PLAN_NEED_CONFIRM, default 1) in interactive.js, where the
 * user is prompted to choose a strategy for each step before execution begins.
 *
 * Input: user task text + optional KB retrieval summary.
 * Output: { summary, steps: [{ goal, strategies: [{ name, description, recommended }] }], fallback }
 *
 * Complexity gating: needsPlanning(text) decides whether a task is complex
 * enough to enter plan mode at all. The caller (interactive.js) gates on it
 * before invoking generatePlan, so trivial tasks skip straight to the loop.
 *
 * Any failure (LLM exception, JSON parse, empty / malformed output) returns a
 * fallback object (empty steps) so the caller can skip plan mode and proceed
 * directly into the agent loop.
 */

const SYSTEM_PROMPT = `You are a planning assistant for hk2, a knowledge-base-driven coding agent.

Given a user's task and (optionally) a KB retrieval summary, decompose the task
into an ordered execution plan. For EACH step, propose multiple candidate
strategies - different reasonable ways to accomplish that step - and mark exactly
one as recommended.

Rules:
- Produce 2 to 5 steps. Steps must be concrete and ordered.
- 2 to 4 strategies per step.
- Exactly one strategy per step has "recommended": true.
- "name": a short label (<= 6 words). "description": one line of detail.
- "goal": a short imperative describing what the step achieves.
- "summary": one line describing the whole plan.

Only output strict JSON. No markdown fences, no explanation:
{"summary": string, "steps": [{"goal": string, "strategies": [{"name": string, "description": string, "recommended": boolean}]}]}`;

/* ----------------------------------------------------------------------
 * Complexity gating for plan mode.
 *
 * Not every task merits the interactive plan + per-step confirmation flow -
 * greetings, single reads, quick questions, and one-line edits should skip
 * straight to the agent loop. needsPlanning() applies lightweight heuristics
 * to decide. Design bias: when ambiguous, PLAN. Skipping is only safe for
 * tasks we're confident are simple; the cost of a missed plan (running a
 * complex task without confirmation) outweighs the cost of one extra prompt.
 * ---------------------------------------------------------------------- */

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
 * Decide whether a task is complex enough to warrant interactive planning +
 * per-step confirmation. Returns true for multi-step / multi-file /
 * non-trivial tasks; false for trivial ones (greetings, single reads, quick
 * questions, terse commands). See the gating constants above for the rules.
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

/**
 * Use stream rather than complete: lets us pass enableReasoning:false to skip
 * the reasoning-content overhead, and forward an abort signal.
 */
async function callLlm(llm, messages, opts) {
  let out = '';
  for await (const evt of llm.stream(messages, opts)) {
    if (evt.type === 'delta') out += evt.text;
  }
  return out;
}

function fallback() {
  return { summary: '', steps: [], fallback: true };
}

function extractJsonObject(raw) {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

function coerceStrategies(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    const description = typeof s.description === 'string' ? s.description.trim() : '';
    if (!name) continue;
    out.push({ name, description, recommended: !!s.recommended });
  }
  return out;
}

/**
 * Validate / normalize the parsed JSON into a plan. Returns null if it does not
 * meet the minimum shape (>= 2 steps, >= 2 strategies each). Ensures exactly
 * one strategy per step is recommended (forces the first if zero or many).
 */
function normalizePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = [];
  for (const st of stepsRaw) {
    if (!st || typeof st !== 'object') continue;
    const goal = typeof st.goal === 'string' ? st.goal.trim() : '';
    const strategies = coerceStrategies(st.strategies);
    if (!goal || strategies.length < 2) continue;
    const recs = strategies.filter(s => s.recommended);
    if (recs.length !== 1) {
      for (const s of strategies) s.recommended = false;
      strategies[0].recommended = true;
    }
    steps.push({ goal, strategies });
  }
  if (steps.length < 2) return null;
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return { summary, steps, fallback: false };
}

/**
 * @param {import('../llm/client.js').LLMClient} llm
 * @param {string} userText                  Trimmed user task text
 * @param {{graphSummary?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<{summary: string, steps: Array<{goal: string, strategies: Array<{name: string, description: string, recommended: boolean}>}>, fallback: boolean}>}
 */
export async function generatePlan(llm, userText, opts = {}) {
  if (!userText || !userText.trim()) return fallback();
  const { graphSummary, signal } = opts;
  const userContent = graphSummary
    ? `Task: ${userText}\n\nKB context summary: ${graphSummary}`
    : `Task: ${userText}`;

  try {
    const raw = await callLlm(
      llm,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      {
        temperature: 0.2,
        maxChars: 4096,
        enableReasoning: false,
        timeoutMs: 30000,
        signal,
      }
    );

    const parsed = extractJsonObject(raw);
    if (!parsed) return fallback();
    const plan = normalizePlan(parsed);
    return plan || fallback();
  } catch {
    return fallback();
  }
}

export default generatePlan;
