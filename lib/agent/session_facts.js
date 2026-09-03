/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 会话事实层（Session Facts）：解决"长会话丢失早期信息"的结构性缺陷。
 *
 * 用户在会话中陈述的环境事实（测试 IP / 端口 / 版本号 / 账号名 / 部署
 * 约束 / 个人偏好…）此前只有两条存活路径，两条都会丢：
 *
 *   A. 对话历史（session.messages）——压缩时摘要输入只取尾部 48k 字符
 *      （turn_support.js summarizeConversation 的 tail-only slice），早期
 *      消息连摘要器都看不到；不压缩时 provider 端硬截断同样最先丢最老
 *      的消息；即使仍在窗口内也有"针在草堆"注意力衰减。
 *   B. KB 条目——matchPrinciples 只匹配 title/keywords，不索引 intro
 *      正文，事实藏在正文里则永不命中；且模型不知道"该去 KB 找"。
 *
 * 本模块提供独立的第三层：会话级持久事实，落盘到
 *   ~/.hk2/sessions/<projectId>/<sessionId>.facts.json
 * （与 transcript 同目录，resume 后同一会话继续追加）。
 *
 * 每轮 turn 开始时把事实渲染为一条常驻 system 消息（"## Session facts"
 * 开头，ensureSessionFactsMessage），随主系统提示一起发送；事实更新时
 * 原地刷新该消息而非追加。compactMessages 保留所有非 foldable 的
 * leading system 消息，事实消息因此天然免疫压缩。
 *
 * 读写全部 best-effort：磁盘 IO 失败只降级为"本轮无事实"，绝不阻塞
 * 主流程。
 *-------------------------------------------------------------------------*/
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, exists } from '../util/fs_atomic.js';
import { SESSIONS_ROOT } from '../config/home.js';

/**
 * Facts message header — compactMessages 以 header 前缀识别 foldable 的
 * 压缩摘要/KB 上下文消息；本模块的 header 不在 foldable 列表里，所以
 * standing system 消息的保留规则会原样携带它跨压缩。
 */
export const FACTS_HEADER = '## Session facts';

function factsPath(projectId, sessionId) {
  return path.join(SESSIONS_ROOT, projectId, `${sessionId}.facts.json`);
}

/**
 * 读取会话事实。返回字符串数组（可能为空）；任何失败返回空数组
 * （best-effort：读不到 ≠ 出错，只是"没有可注入的事实"）。
 */
export async function loadSessionFacts(projectId, sessionId) {
  if (!projectId || !sessionId) return [];
  try {
    const p = factsPath(projectId, sessionId);
    if (!(await exists(p))) return [];
    const data = await readJsonSafe(p, null);
    if (!data || !Array.isArray(data.facts)) return [];
    // 防御：只接受非空字符串，逐条裁剪长度
    return data.facts
      .filter(f => typeof f === 'string' && f.trim())
      .map(f => f.trim().slice(0, 500));
  } catch {
    return [];
  }
}

/**
 * 追加事实（去重：规范化后与既有事实相同的跳过）。返回写入后的完整
 * 列表；写失败返回 null（调用方降级处理，不阻塞）。
 */
export async function addSessionFact(projectId, sessionId, fact, opts = {}) {
  if (!projectId || !sessionId) return null;
  const text = String(fact || '').trim().slice(0, 500);
  if (!text) return null;
  try {
    const p = factsPath(projectId, sessionId);
    const data = (await exists(p)) ? (await readJsonSafe(p, null)) : null;
    const facts = Array.isArray(data?.facts) ? data.facts.filter(f => typeof f === 'string') : [];
    const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    if (facts.some(f => norm(f) === norm(text))) return facts; // dedup
    facts.push(text);
    // 上限 100 条：事实层是精选层不是日志层；超出后拒绝新条目（保留
    // 最早的——环境事实越早越可能是会话的"设定"）。
    if (facts.length > 100) return facts.slice(0, 100);
    await writeJsonAtomic(p, {
      facts,
      updatedAt: new Date().toISOString(),
      ...(opts.source ? { lastSource: opts.source } : {}),
    });
    return facts;
  } catch {
    return null;
  }
}

/**
 * 删除事实。query 为空清除全部；否则做规范化子串匹配（/forget 免输
 * 完整原文）。返回删除后的列表；无匹配/失败返回 null。
 */
export async function removeSessionFacts(projectId, sessionId, query) {
  if (!projectId || !sessionId) return null;
  try {
    const p = factsPath(projectId, sessionId);
    if (!(await exists(p))) return null;
    const data = await readJsonSafe(p, null);
    if (!data || !Array.isArray(data.facts)) return null;
    if (!query || !query.trim()) {
      await writeJsonAtomic(p, { facts: [], updatedAt: new Date().toISOString(), cleared: true });
      return [];
    }
    const q = query.trim().toLowerCase();
    const norm = s => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
    const kept = data.facts.filter(f => !norm(f).includes(q));
    if (kept.length === data.facts.length) return null; // nothing matched
    await writeJsonAtomic(p, { facts: kept, updatedAt: new Date().toISOString() });
    return kept;
  } catch {
    return null;
  }
}

/**
 * 渲染事实消息正文（含 header）。facts 为空返回 null（调用方不注入，
 * 会话保持与无事实时完全一致的消息形状）。
 */
export function renderFactsMessage(facts) {
  const list = (facts || []).filter(f => typeof f === 'string' && f.trim());
  if (list.length === 0) return null;
  const body = list.map(f => `- ${f}`).join('\n');
  return `${FACTS_HEADER} (persistent across this session — never compacted away)\n` +
    `The following facts were stated by the user (or extracted from earlier conversation) during this session. ` +
    `They are ALWAYS in scope: use them instead of asking the user again, and trust them over guesses when the current context seems to conflict.\n\n${body}`;
}

/**
 * 幂等地维护 session.messages 里的事实消息：有事实且尚无消息 → 在主
 * 系统提示（messages[0]）之后插入；已有 → 原地刷新内容；事实清空 →
 * 移除该消息。返回最终事实列表（供调用方审计/日志）。
 */
export function ensureSessionFactsMessage(session, facts) {
  if (!session || !Array.isArray(session.messages)) return facts || [];
  const body = renderFactsMessage(facts);
  const idx = session.messages.findIndex(m =>
    m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(FACTS_HEADER));
  if (!body) {
    if (idx >= 0) session.messages.splice(idx, 1);
    return [];
  }
  if (idx >= 0) {
    session.messages[idx].content = body; // in-place refresh, never append
    return facts;
  }
  // Insert right after the leading system prompt (index 0); when no system
  // message exists yet (shouldn't happen — the turn pipeline builds it first)
  // fall back to unshifting at the head.
  const insertAt = session.messages[0]?.role === 'system' ? 1 : 0;
  session.messages.splice(insertAt, 0, { role: 'system', content: body });
  return facts;
}
