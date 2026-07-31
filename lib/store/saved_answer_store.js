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
 * 已save答案存储：user在「原理讲解」模式generate的答案可手动持久化，
 * 下次相同 / 相似问题先查cache命中直接展示，不满意可点「重新generate」。
 *
 * 持久化：.kb/<kb>/answers/<id>.json（每条独立file，便于atomic写与list）
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeJsonAtomic, readJsonSafe, exists } from '../util/fs_atomic.js';
import { kbDir } from './kb_store.js';
import { tokenizeText } from '../index/text_tokenizer.js';

export function answersDir(name) {
  return path.join(kbDir(name), 'answers');
}

function newId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `ans_${ts}_${rnd}`;
}

export async function createSavedAnswer(kbName, data) {
  const id = newId();
  const record = {
    id,
    kbName,
    mode: data.mode || 'principle',
    query: data.query || '',
    rewrite: data.rewrite || null,
    topics: data.topics || [],
    symbols: data.symbols || [],
    answer: data.answer || '',
    createdAt: new Date().toISOString(),
  };
  await fs.mkdir(answersDir(kbName), { recursive: true });
  await writeJsonAtomic(path.join(answersDir(kbName), `${id}.json`), record);
  return record;
}

export async function getSavedAnswer(kbName, id) {
  const p = path.join(answersDir(kbName), `${id}.json`);
  return readJsonSafe(p, null);
}

export async function listSavedAnswers(kbName, opts = {}) {
  const dir = answersDir(kbName);
  if (!await exists(dir)) return [];
  const entries = await fs.readdir(dir);
  const result = [];
  for (const ent of entries) {
    if (!ent.endsWith('.json')) continue;
    const data = await readJsonSafe(path.join(dir, ent), null);
    if (!data) continue;
    if (opts.mode && data.mode !== opts.mode) continue;
    result.push(data);
  }
  result.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return result;
}

export async function deleteSavedAnswer(kbName, id) {
  const p = path.join(answersDir(kbName), `${id}.json`);
  if (!await exists(p)) return false;
  await fs.unlink(p);
  return true;
}

/**
 * 把function名 / 关键词list拆成 token set。
 * `lazy_vacuum_rel` -> {lazy, vacuum, rel}
 * `index_cleanup`   -> {index, cleanup}
 * `vacuumlazy`      -> {vacuumlazy}（无minute隔符不强行拆，否则噪声太大）
 * skip 1 字符 token。
 */
function splitToTokens(names) {
  const s = new Set();
  for (const name of names || []) {
    if (typeof name !== 'string') continue;
    for (const t of name.toLowerCase().split(/[_\s]+/)) {
      const trimmed = t.trim();
      if (trimmed && trimmed.length > 1) s.add(trimmed);
    }
  }
  return s;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of b) if (a.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 在已save答案中找与 query 最相似的一条。
 *
 * 三路信号：
 *   - functionName 子 token Jaccard（拆 `lazy_vacuum_rel` -> {lazy, vacuum, rel}，
 *     避免 LLM 给出 `lazy_vacuum` vs `lazy_vacuum_rel` 这种相关但不一致的命名导致漏match）
 *   - keyword 子 token Jaccard
 *   - 原始 query token overlap coefficient（向后兼容无 rewrite 的旧记录）
 *
 * LLM 对同义改写给出的 functionName 不稳定（如「何hour触发」vs「什么hour候会去」可能给不同function名），
 * 所以用 max(fn, kw) 作主信号而非加权平均，避免一个信号弱就拖垮整体。
 * 阈值default 0.4。
 */
export async function matchSavedAnswer(kbName, query, opts = {}) {
  const mode = opts.mode || 'principle';
  const threshold = opts.threshold ?? 0.4;
  const all = await listSavedAnswers(kbName, { mode });
  if (all.length === 0) return null;

  const newFnTokens = splitToTokens(opts.functionNames);
  const newKwTokens = splitToTokens(opts.keywords);
  const tokensNew = new Set(tokenizeText(query));
  if (tokensNew.size === 0 && newFnTokens.size === 0 && newKwTokens.size === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const ans of all) {
    const savedFnTokens = splitToTokens(ans.rewrite?.functionNames);
    const savedKwTokens = splitToTokens(ans.rewrite?.keywords);
    const tokensSaved = new Set(tokenizeText(ans.query || ''));

    const fnScore = jaccard(newFnTokens, savedFnTokens);
    const kwScore = jaccard(newKwTokens, savedKwTokens);

    let qScore = 0;
    if (tokensNew.size > 0 && tokensSaved.size > 0) {
      let inter = 0;
      for (const t of tokensSaved) if (tokensNew.has(t)) inter++;
      if (inter >= 2) qScore = inter / Math.min(tokensNew.size, tokensSaved.size);
    }

    // 有 rewrite 信号hour取 max(fn, kw) 为主，qScore 作少量加minute；
    // 无 rewrite 信号退化到纯 query token match
    let score;
    if (fnScore > 0 || kwScore > 0) {
      score = Math.max(fnScore, kwScore) + 0.2 * qScore;
    } else {
      score = qScore;
    }

    if (score > bestScore) { bestScore = score; best = ans; }
  }
  return bestScore >= threshold ? best : null;
}
