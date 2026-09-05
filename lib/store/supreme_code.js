/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。易景科技是上述软件的知识产权，以及与本软件相关的所有信息内容（包
 * 括但不限于文字、图片、音频、视频、图表、界面设计、版面框架、有关数据或
 * 电子文档等）均受中华人民共和国法律法规和相应的国际条约保护，易景科技享
 * 有上述知识产权，但相关权利人依照法律规定应享有的权利除外，未免疑义，本
 * 条所指的"知识产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、
 * 商号、域名、与商标和商号相关的商誉、设计和专利；与创新、技术诀窍、商业
 * 秘密、保密技术、非公开信息相关的权利；（b）人身权、掩模作品权、署名权
 * 和发表权；以及（c）在本协议生效之前已存在或此后出现在世界任何地方的其他
 * 工业产权、专有权、与"知识产权"相关的权利，以及上述权利的所有续期和延长，
 * 无论此类权利是否已在相关法域内的相关机构注册。
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
 *-------------------------------------------------------------------------*/

/**
 * Supreme Code store — the project's fundamental law entry.
 *
 * Every project's Holy Space carries ONE permanent, fixed knowledge entry
 * with id `hk2-supreme-code`. It holds up to SUPREME_CODE_MAX_ITEMS code
 * items (1-based, gapless numbering), each at most SUPREME_CODE_MAX_CHARS
 * characters. The entry:
 *   - is created empty by /kb init (addKbForProject),
 *   - may receive a best-effort empty self-heal when a legacy reader is
 *     missing it (never overwriting existing content; failures are non-fatal)
 *     at KB runtime load and by /kb status; status therefore has a rare
 *     write-on-read side effect,
 *   - can NOT be deleted, renamed, moved, or auto-updated; only explicit
 *     /kb code add|del commands (each requiring y/N confirmation) may
 *     change its items,
 *   - is injected into every system prompt so all agent operations must
 *     obey it.
 *
 * Item content should be short and imperative. Genuinely complex rules
 * belong in their own Holy KB entry, referenced from a code item, e.g.
 * "代码规范必须严格遵循 **KB(project-code-format)**".
 */
import { readKnowledge, writeKnowledge } from './kb_store.js';

/** Permanent entry id — never delete, never rename. */
export const SUPREME_CODE_ID = 'hk2-supreme-code';
/** Maximum number of code items. */
export const SUPREME_CODE_MAX_ITEMS = 100;
/** Maximum length of one code item, in characters. */
export const SUPREME_CODE_MAX_CHARS = 200;

export function isSupremeCode(id) {
  return typeof id === 'string' && id === SUPREME_CODE_ID;
}

/**
 * Defensively normalize a raw `codes` array (possibly hand-edited on disk)
 * into an array of trimmed non-empty strings, capped at MAX_ITEMS.
 * Pure function; never throws.
 */
export function normalizeCodes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    const s = String(item).replace(/\s+/g, ' ').trim();
    if (s.length === 0) continue;
    out.push(s.length > SUPREME_CODE_MAX_CHARS ? s.slice(0, SUPREME_CODE_MAX_CHARS) : s);
    if (out.length >= SUPREME_CODE_MAX_ITEMS) break;
  }
  return out;
}

/**
 * Validate a full code-items array. Pure.
 * @returns {{ok: boolean, errors: Array<{index: number, reason: string}>}}
 */
export function validateCodes(items) {
  const errors = [];
  if (!Array.isArray(items)) {
    return { ok: false, errors: [{ index: -1, reason: 'codes must be an array' }] };
  }
  if (items.length > SUPREME_CODE_MAX_ITEMS) {
    errors.push({ index: -1, reason: `too many items: ${items.length} > ${SUPREME_CODE_MAX_ITEMS}` });
  }
  items.forEach((item, i) => {
    if (typeof item !== 'string') {
      errors.push({ index: i, reason: `item ${i + 1}: not a string` });
      return;
    }
    if (item.trim().length === 0) {
      errors.push({ index: i, reason: `item ${i + 1}: empty` });
      return;
    }
    if (item.length > SUPREME_CODE_MAX_CHARS) {
      errors.push({ index: i, reason: `item ${i + 1}: ${item.length} chars > max ${SUPREME_CODE_MAX_CHARS}` });
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a single candidate item content. Pure.
 * @returns {{ok: boolean, reason?: string, content: string}}
 */
export function validateOneCodeItem(content) {
  const s = typeof content === 'string' ? content.replace(/\s+/g, ' ').trim() : '';
  if (s.length === 0) return { ok: false, reason: 'code content is empty', content: s };
  if (s.length > SUPREME_CODE_MAX_CHARS) {
    return { ok: false, reason: `code content is ${s.length} chars (max ${SUPREME_CODE_MAX_CHARS})`, content: s };
  }
  return { ok: true, content: s };
}

/** Parse a user-supplied code-id string ("1".."100"). Returns integer or null. */
export function parseCodeItemId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;            // no "2.5", "abc", ""
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > SUPREME_CODE_MAX_ITEMS) return null;
  return n;
}

/**
 * Plan an add-or-update: insert (id === count+1 or beyond given as append) or
 * replace (id <= count). Ids beyond count+1 are rejected — numbering must
 * stay gapless. Pure; returns the new array without mutating the input.
 *
 * @param {string[]} codes   current items
 * @param {number|null} id   target 1-based position, or null to append
 * @param {string} content   the (already whitespace-normalized) item text
 */
export function planCodeAdd(codes, id, content) {
  const check = validateOneCodeItem(content);
  if (!check.ok) return { ok: false, error: check.reason };
  const list = Array.isArray(codes) ? codes.slice() : [];
  const count = list.length;
  let pos;
  if (id === null || id === undefined) {
    pos = count + 1;                       // append
  } else {
    pos = id;
    if (pos > count + 1) {
      return { ok: false, error: `code-id ${pos} would leave a gap (current count: ${count}; max allowed: ${count + 1})` };
    }
  }
  if (pos > SUPREME_CODE_MAX_ITEMS) {
    return { ok: false, error: `supreme code is full (${SUPREME_CODE_MAX_ITEMS} items max)` };
  }
  const out = list.slice();
  if (pos <= count) out[pos - 1] = check.content;        // update in place
  else out.push(check.content);                           // append
  return { ok: true, action: pos <= count ? 'update' : 'append', id: pos, codes: out };
}

/**
 * Plan a deletion: remove item `id` and shift the rest up so numbering stays
 * gapless (delete #6 → old #7 becomes #6, etc.). Pure.
 */
export function planCodeDel(codes, id) {
  const list = Array.isArray(codes) ? codes.slice() : [];
  if (!Number.isInteger(id) || id < 1 || id > list.length) {
    return { ok: false, error: `invalid code-id ${id} (valid range: 1..${list.length})` };
  }
  const removed = list[id - 1];
  const out = list.slice(0, id - 1).concat(list.slice(id));
  return { ok: true, removed, id, codes: out };
}

/** Human-readable intro rendered into the entry (and shown by /kb knowledge show). */
export function renderSupremeCodeIntro(codes) {
  const head =
    "The project's Supreme Code — the fundamental laws every hk2 operation in this project MUST obey; they can never be violated. " +
    `This entry is permanent: it cannot be deleted, renamed, moved, or auto-updated. Items are managed exclusively via /kb code add and /kb code del (each requires explicit user confirmation). ` +
    `Limits: at most ${SUPREME_CODE_MAX_ITEMS} items, ${SUPREME_CODE_MAX_CHARS} characters each, numbered 1..N with no gaps.`;
  if (!codes || codes.length === 0) {
    return `${head}\n\n(no code items yet — add the first one with: /kb code add --code-content="...")`;
  }
  const body = codes.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `${head}\n\nCode items:\n${body}`;
}

/**
 * Read the supreme-code entry from Holy space.
 * @returns {Promise<{entry: object, codes: string[]} | null>} null when absent.
 */
export async function readSupremeCode(name) {
  const entry = await readKnowledge(name, 'holy', SUPREME_CODE_ID).catch(() => null);
  if (!entry) return null;
  return { entry, codes: normalizeCodes(entry.codes) };
}

/**
 * Write the supreme-code entry (Holy space). Preserves createdAt and title
 * when the entry already exists. Revalidates items; throws on violation.
 * @returns {Promise<{entry: object, path: string}>}
 */
export async function writeSupremeCode(name, codes, opts = {}) {
  const raw = Array.isArray(codes) ? codes : [];
  // Validate the RAW items first — a >200-char or empty item is a caller bug
  // and must THROW, not be silently truncated by normalizeCodes.
  const check = validateCodes(raw);
  if (!check.ok) {
    throw new Error(`invalid supreme code items: ${check.errors.map(e => e.reason).join('; ')}`);
  }
  const list = normalizeCodes(raw);
  const existing = await readKnowledge(name, 'holy', SUPREME_CODE_ID).catch(() => null);
  const record = {
    id: SUPREME_CODE_ID,
    space: 'holy',
    title: existing?.title || 'Project Supreme Code',
    intro: renderSupremeCodeIntro(list),
    codes: list,
    // Structural flags — consulted by guards that must refuse to touch this entry.
    protected: true,
    permanent: true,
    createdAt: existing?.createdAt || new Date().toISOString(),
    ...(opts.createdVia ? { createdVia: opts.createdVia } : (existing?.createdVia ? { createdVia: existing.createdVia } : {})),
  };
  const p = await writeKnowledge(name, 'holy', record);
  return { entry: record, path: p };
}

/**
 * Ensure the supreme-code entry exists — create an EMPTY one only when the
 * project's Holy space is missing it. NEVER overwrites existing content
 * (self-heal is additive only). Used by /kb init and KB runtime load.
 * @returns {Promise<{created: boolean, codes: string[]}>}
 */
export async function ensureSupremeCode(name, opts = {}) {
  const existing = await readSupremeCode(name);
  if (existing) return { created: false, codes: existing.codes };
  const { entry } = await writeSupremeCode(name, [], opts);
  return { created: true, codes: entry.codes };
}

/**
 * System prompt for --code-gen: the model drafts exactly ONE code item from
 * the user's instructions. Exported for unit tests.
 */
export function buildCodeGenPrompt(instructions, existingCodes) {
  const existing = (existingCodes || [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join('\n');
  return [
    'You are drafting ONE item of this project\'s Supreme Code (法典) for the hk2 coding agent.',
    'The Supreme Code is the set of fundamental laws that EVERY operation in this project (reading, writing, editing code, running commands, planning) must strictly obey — they can never be violated.',
    '',
    'Hard rules for your output:',
    `- Output EXACTLY ONE code item as plain text. No numbering, no markdown, no quotes, no code fences, no explanations, no surrounding whitespace.`,
    `- Maximum ${SUPREME_CODE_MAX_CHARS} characters; aim for under 120. Be concise, imperative, unambiguous.`,
    '- State a hard, absolute rule (e.g. "API Keys must NEVER appear in any code file").',
    `- If the rule is too complex to state in one short item, keep the item short and reference a KB entry id for the details, e.g. "代码规范必须严格遵循 **KB(project-code-format)**".`,
    existing ? '- Do not duplicate or contradict the existing items listed below.' : '',
    '',
    existing ? 'Existing supreme code items:' : '',
    existing || '(none yet)',
    '',
    'User instructions for the new item:',
    String(instructions || '').trim(),
  ].filter(l => l !== '' || true).join('\n');
}

/**
 * Clean up a model-generated item: strip code fences, surrounding quotes,
 * leading numbering ("1.", "法条1：", "Code 1:"), and collapse whitespace.
 * Returns the cleaned single-line string (may be empty).
 */
export function sanitizeGeneratedCodeItem(text) {
  let s = String(text ?? '');
  // strip a fenced block if the whole answer is one
  const fence = /^\s*```[a-zA-Z]*\s*([\s\S]*?)\s*```\s*$/.exec(s);
  if (fence) s = fence[1];
  s = s.replace(/^\s*[-*]\s+/, '');                    // leading bullet
  s = s.replace(/^\s*(?:code[- ]?item|item|法条|规则)\s*\d+\s*[.、:：)\]]?\s*/i, '');
  s = s.replace(/^\s*\d+\s*[.、:：)\]]\s*/, '');        // "1." / "1、" / "1:"
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '');     // wrapping quotes
  return s.replace(/\s+/g, ' ').trim();
}
