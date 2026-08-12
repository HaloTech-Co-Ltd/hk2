/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 任务状态持久化：当一个任务因为不可预知的原因（LLM 错误、进程崩溃、
 * 用户 ESC 中断）被打断后，用户通常会输入"请继续 / continue / go ahead"
 * 之类的指令要求恢复。但此时 LLM 完全丢失了当前任务的信息——它只看到
 * 一句孤立的"请继续"，无法重建"刚才在做什么、做到哪一步、下一步该做什么"。
 *
 * 本模块把"当前任务摘要 + 进度面板状态"落盘到
 *   ~/.hk2/sessions/<projectId>/taskstate.json
 * （与 transcript 同目录），并提供：
 *   - saveTaskState(projectId, state)：原子写入任务状态
 *   - loadTaskState(projectId)：读取最近一次任务状态
 *   - clearTaskState(projectId)：任务正常完成后清空
 *
 * 读写都做了 best-effort 容错：磁盘 IO 失败不影响主流程，只是恢复能力退化。
 *-------------------------------------------------------------------------*/
import { writeJsonAtomic, readJsonSafe, exists } from '../util/fs_atomic.js';
import { projectTaskStatePath } from '../config/home.js';

/**
 * 持久化当前任务状态。state 形如：
 *   {
 *     userRequest: string,         // 最近一次用户的原始请求
 *     taskSummary: string,        // 文本化的任务/进度摘要（供 LLM 恢复记忆）
 *     planProgress: object|null,  // 结构化 planProgress（如有），用于恢复进度面板
 *     interruptedAt: string,      // ISO 时间戳
 *     sessionId: string|null,     // 关联的 transcript session id
 *   }
 * 写入失败只打 warn，不抛——持久化是 best-effort，不能阻塞主流程。
 */
export async function saveTaskState(projectId, state) {
  if (!projectId) return;
  try {
    const payload = {
      ...state,
      interruptedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(projectTaskStatePath(projectId), payload);
  } catch (err) {
    console.error(`[warn] failed to persist task state: ${err.message}`);
  }
}

/**
 * 读取最近一次落盘的任务状态。返回 null 表示没有可恢复的状态
 * （首次启动、文件不存在、或 JSON 损坏）。
 */
export async function loadTaskState(projectId) {
  if (!projectId) return null;
  try {
    const p = projectTaskStatePath(projectId);
    if (!(await exists(p))) return null;
    const data = await readJsonSafe(p, null);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * 清除落盘的任务状态。任务正常完成（finalizePlanProgress 把 planProgress
 * 清成 null）时调用，避免下次启动误恢复一个已经结束的任务。
 */
export async function clearTaskState(projectId) {
  if (!projectId) return;
  try {
    const p = projectTaskStatePath(projectId);
    if (await exists(p)) {
      const fs = await import('node:fs/promises');
      await fs.unlink(p).catch(() => {});
    }
  } catch {
    // best-effort
  }
}
