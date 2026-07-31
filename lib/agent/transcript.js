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
 * Session transcript: JSONL.
 * One line per event: {ts, type, ...}
 *
 * Types:
 *   - system_prompt     {text}
 *   - user              {text}
 *   - assistant         {text}  (aggregated; equals the full assistant message)
 *   - tool_call         {id, name, arguments, result}
 *   - turn_end          {turns, toolCalls}
 *   - meta              {key, value}
 *
 * File: ~/.hk2/sessions/<projectId>/<sessionId>.jsonl
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../util/fs_atomic.js';
import { projectSessionPath } from '../config/home.js';

export class Transcript {
  constructor(projectId, sessionId) {
    this.projectId = projectId;
    this.sessionId = sessionId || randomUUID();
    this.path = projectSessionPath(projectId, this.sessionId);
    this.startedAt = new Date().toISOString();
    this._ensure = null;
  }

  async _init() {
    if (this._ensure) return this._ensure;
    this._ensure = (async () => {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      // Write the first line directly to avoid the append → _init recursion deadlock
      const line = JSON.stringify({
        ts: this.startedAt,
        type: 'session_start',
        sessionId: this.sessionId,
        projectId: this.projectId,
      }) + '\n';
      await writeFileAtomic(this.path, line);
    })();
    return this._ensure;
  }

  async append(event) {
    await this._init();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    await writeFileAtomic(this.path, line);
  }

  async logUser(text) {
    await this.append({ type: 'user', text });
  }

  async logAssistant(text) {
    await this.append({ type: 'assistant', text });
  }

  async logToolCall(call, result) {
    await this.append({
      type: 'tool_call',
      id: call.id, name: call.name,
      arguments: call.arguments,
      result: result.ok ? result.result : { error: result.error },
      ok: result.ok,
      // KB-first guard snapshot AFTER this call ran — useful for reconstructing
      // why a hint did or didn't fire for a later bash/read call.
      kbGuard: result.guard || undefined,
    });
  }

  async logTurn(turnIdx, toolCalls) {
    await this.append({ type: 'turn_end', turnIdx, toolCalls });
  }

  async logMeta(key, value) {
    await this.append({ type: 'meta', key, value });
  }

  async logSystemPrompt(text) {
    await this.append({ type: 'system_prompt', text });
  }
}

export default Transcript;
