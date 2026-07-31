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
 * In-memory proposal stash for ast_edit's preview/accept flow.
 *
 * ast_edit runs as a dry-run: it computes the proposed writes but does NOT
 * touch the filesystem. Instead it stages them here and returns a proposalId.
 * `resolve` then either applies (writing all files atomically-ish) or
 * discards (dropping the entry).
 *
 * Bounds:
 *   - Max 16 active proposals per process (LRU eviction when exceeded).
 *   - 10-minute TTL; stale entries are pruned on access.
 *
 * No persistence: a crashed process drops everything. That's intentional —
 * proposals are previews, not authoritative state.
 */

const MAX_PROPOSALS = 16;
const TTL_MS = 10 * 60 * 1000;

/** Map<proposalId, { files: [{ path, abs, next, prev, tag }], createdAt, lastTouched }> */
const stash = new Map();

function now() { return Date.now(); }

function prune() {
  const t = now();
  for (const [id, entry] of stash) {
    if (t - entry.createdAt > TTL_MS) stash.delete(id);
  }
  // LRU evict oldest if still over capacity
  while (stash.size > MAX_PROPOSALS) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, entry] of stash) {
      if (entry.lastTouched < oldestTs) { oldestTs = entry.lastTouched; oldestId = id; }
    }
    if (oldestId) stash.delete(oldestId); else break;
  }
}

export function stage(id, files) {
  prune();
  stash.set(id, { files, createdAt: now(), lastTouched: now() });
}

export function get(id) {
  const entry = stash.get(id);
  if (!entry) return null;
  if (now() - entry.createdAt > TTL_MS) {
    stash.delete(id);
    return null;
  }
  entry.lastTouched = now();
  return entry;
}

export function drop(id) {
  return stash.delete(id);
}

export function listIds() {
  prune();
  return Array.from(stash.keys());
}

export function size() {
  return stash.size;
}

/** Test-only: clear all. */
export function _reset() {
  stash.clear();
}
