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
