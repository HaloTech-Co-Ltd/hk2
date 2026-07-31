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
 * Resumable build checkpoint.
 *
 * Path: ~/.hk2/kb/<kbName>/checkpoint.json
 *
 * Format:
 *   {
 *     phase: 'parse' | 'done',
 *     processedFiles: [{ path, hash }, ...],
 *     lastSavedAt: ISO,
 *     interval: number
 *   }
 *
 * Lifecycle:
 *   await cp.load()           # reads existing checkpoint (if any)
 *   cp.has(path, hash)        # true if this exact file was already processed
 *   await cp.markDone(path, hash)
 *   await cp.saveIfDue(cb)    # saves every `interval` markDone calls
 *   await cp.finalize()       # always flushes (does NOT clear)
 *   await cp.clear()          # deletes the checkpoint file (on success)
 *
 * The indexer calls load → loop(markDone+saveIfDue) → finalize → ...
 * → clear on success. If the process is killed mid-loop, the next run
 * resumes by skipping files present in `processedFiles` with matching hash.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, exists, rmrf } from '../util/fs_atomic.js';
import { kbDir } from '../store/kb_store.js';

export function checkpointPath(name) {
  return path.join(kbDir(name), 'checkpoint.json');
}

export class Checkpoint {
  /**
   * @param {string} kbName
   * @param {{ interval?: number, enabled?: boolean }} [opts]
   */
  constructor(kbName, opts = {}) {
    this.kbName = kbName;
    this.interval = opts.interval ?? 100;
    this.enabled = opts.enabled !== false;
    /** @type {Map<string, string>} path → hash */
    this.processed = new Map();
    this.phase = 'parse';
    this._counter = 0;
    this._loaded = false;
  }

  async load() {
    if (!this.enabled || this._loaded) return;
    this._loaded = true;
    const cp = await readJsonSafe(checkpointPath(this.kbName), null);
    if (!cp || !Array.isArray(cp.processedFiles)) return;
    for (const { path: p, hash } of cp.processedFiles) {
      if (p && hash) this.processed.set(p, hash);
    }
    this.phase = cp.phase || 'parse';
  }

  has(filePath, hash) {
    return this.processed.has(filePath) && this.processed.get(filePath) === hash;
  }

  async markDone(filePath, hash) {
    if (!this.enabled) return;
    this.processed.set(filePath, hash);
    this._counter++;
  }

  async saveIfDue(onSave) {
    if (!this.enabled) return;
    if (this._counter < this.interval) return;
    await this._write();
    this._counter = 0;
    if (onSave) onSave();
  }

  async finalize() {
    if (!this.enabled) return;
    await this._write();
  }

  async clear() {
    if (!this.enabled) return;
    const p = checkpointPath(this.kbName);
    if (await exists(p)) await rmrf(p);
    this.processed.clear();
    this._counter = 0;
  }

  async _write() {
    const data = {
      phase: this.phase,
      processedFiles: Array.from(this.processed.entries()).map(([path, hash]) => ({ path, hash })),
      lastSavedAt: new Date().toISOString(),
      interval: this.interval,
    };
    await writeJsonAtomic(checkpointPath(this.kbName), data);
  }

  get size() { return this.processed.size; }
}
