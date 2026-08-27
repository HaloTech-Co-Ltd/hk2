/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * 易景科技是Halo Database、Halo Database Management System、羲和数据
 * 库、羲和数据库管理系统（后面简称 Halo ）软件的发明人同时也为知识产权权
 * 利人。Halo 软件的知识产权，以及与本软件相关的所有信息内容（包括但不限
 * 于文字、图片、音频、视频，图表，界面设计，版面框架，有关数据或电子文档等）
 * 均受中华人民共和国法律法规和相应的国际条约保护，易景科技享有上述知识产
 * 权，但相关权利人依照法律规定应享有的权利除外。未免疑义，本条所指的"知识
 * 产权"是指任何及所有基于 Halo 软件产生的：（a）版权、商标、商号、域名、与
 * 商标和商号相关的商誉、设计和专利；与创新，技术诀窍、商业秘密、保密技术、非
 * 技术信息相关的权利；（b）人身权、掩模作品权、署名权和发表权；以及（c）在
 * 本协议生效之前已存在或此后出现在世界任何地方的其他工业产权、专有权、与"知
 * 识产权"相关的权利，以及上述权利的所有续期和延长，无论此类权利是否已在相
 * 关法域内的相关机构注册。
 *
 * This software and related documentation are provided under a license
 * agreement containing restrictions on use and disclosure and are
 * protected by intellectual property laws. As expressly permitted in
 * your license agreement or allowed by law, you may not use, copy,
 * reproduce, translate, broadcast, modify, license, transmit, distribute,
 * exhibit, perform, publish, or display any part, in any form, or by any
 * means. Reverse engineering, disassembly, or decompilation of this
 * software, unless required by law for interoperability, is prohibited.
 *
 * This software is developed for general use in a variety of
 * information management applications. It is not developed or intended
 * for use in any inherently dangerous applications, including applications
 * that may create a risk of personal injury. If you use this software in
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Input history with JSONL persistence — a capped ring of past inputs
 * (newest last), consecutive-duplicate suppression, and best-effort file
 * writes (a failing disk never breaks the editor).
 *
 * Wire format: one JSON {ts, text} object per line at
 * $HK2_HOME/history.jsonl. On boot load() reads it and compacts to the
 * newest `max` entries; append() adds one line per submit.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../../lib/util/fs_atomic.js';

const DEFAULT_MAX = 1000;

export class History {
  /**
   * @param {string|null} file JSONL path, or null for an in-memory history
   * @param {{max?: number}} opts cap (default 1000)
   */
  constructor(file = null, { max = DEFAULT_MAX } = {}) {
    this.file = file;
    this.max = Math.max(1, max | 0);
    this.items = [];
    this._pending = null; // serialized append chain (order + flush guarantee)
  }

  /** Load from disk (best-effort: missing/corrupt file → empty). */
  async load() {
    if (!this.file) return this;
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch { return this; }
    // Migration: a history written by an older version under a permissive
    // umask may be group/world-readable — tighten it on every load.
    await fs.chmod(this.file, 0o600).catch(() => {});
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && typeof ev.text === 'string' && ev.text.trim()) events.push(ev);
      } catch { /* skip torn trailing line */ }
    }
    // Migration #2: an older build persisted EVERY submitted line — including
    // credential-bearing ones. Scrub them from memory AND rewrite the file so
    // the key does not keep sitting on disk after the upgrade.
    const clean = events.filter((ev) => !isSensitiveInput(ev.text));
    if (clean.length !== events.length) {
      const body = clean.map((ev) => JSON.stringify(ev)).join('\n') + (clean.length > 0 ? '\n' : '');
      await writeFileAtomic(this.file, body).catch(() => { /* best-effort scrub */ });
    }
    const items = clean.map((ev) => ev.text);
    // Compaction on boot: keep only the newest max entries.
    this.items = dedupeConsecutive(items).slice(-this.max);
    return this;
  }

  /** Newest-last snapshot of the in-memory entries. */
  entries() {
    return [...this.items];
  }

  /** Record one submitted input. Consecutive duplicates are collapsed. */
  add(text) {
    const t = String(text ?? '');
    if (!t.trim()) return false;
    // Credential-bearing commands are NEVER persisted — history.jsonl is a
    // convenience feature and must not become a plaintext key store. The
    // documented flows (/model add ... --api-key=..., tokens, Authorization
    // headers pasted from curl) are dropped, not redacted: a partial redaction
    // regex that misses one shape would still leak the key.
    if (isSensitiveInput(t)) return false;
    if (this.items.length > 0 && this.items[this.items.length - 1] === t) return false;
    this.items.push(t);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    if (this.file) {
      // Serialize appends through a promise chain: ordering is guaranteed
      // (concurrent appendFile calls have no defined order) and flush() can
      // await everything before exit. Failures stay best-effort.
      this._pending = (this._pending || Promise.resolve())
        .then(() => fs.appendFile(this.file, JSON.stringify({ ts: new Date().toISOString(), text: t }) + '\n', { encoding: 'utf8', mode: 0o600 }))
        .then(() => fs.chmod(this.file, 0o600).catch(() => {})) // tighten pre-existing files
        .catch(() => { /* best-effort persistence */ });
    }
    return true;
  }

  /** Resolves once every pending append has landed on disk (or failed). */
  flush() {
    return this._pending || Promise.resolve();
  }
}

/**
 * True for inputs that carry a secret and must never reach history.jsonl.
 * Matches the documented credential flags plus pasted Authorization headers
 * and key=value secret/password assignments.
 */
export function isSensitiveInput(text) {
  const t = String(text ?? '');
  return /--api-?key(\s*=|\s+\S)/i.test(t)
    || /--token(\s*=|\s+\S)/i.test(t)
    || /authorization\s*:/i.test(t)
    || /(^|[^a-z])(password|passwd|secret|api[_-]?key)\s*=\s*\S/i.test(t);
}

function dedupeConsecutive(items) {
  const out = [];
  for (const it of items) {
    if (out.length === 0 || out[out.length - 1] !== it) out.push(it);
  }
  return out;
}

/** Default history path under the given HK2 home dir. */
export function historyPath(hk2Home) {
  return path.join(hk2Home, 'history.jsonl');
}
