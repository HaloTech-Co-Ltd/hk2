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
 * Progress indicator: shows a spinner + phase + elapsed time during LLM
 * generation (principle / impl / interactive modes).
 *
 * TTY mode: refresh the same line with \r; clear it when the first delta arrives.
 * Non-TTY (piped): print `[phase...]` header only, no spinner.
 *
 * Phase flow:
 *   start(query-rewrite | waiting-for-model) -> rewrite event -> nextPhase(retrieving)
 *   -> first delta -> tick() clears spinner -> stdout stream
 *   -> done() prints final stats
 *
 * Themed via lib/agent/style.js.
 */

import { SPINNER, ICON, accent, muted, dim, success } from '../lib/agent/style.js';

export class ProgressIndicator {
  constructor(stream = process.stderr) {
    this.stream = stream;
    this.isTTY = !!stream.isTTY;
    this.phase = null;
    this.phaseStart = 0;
    this.totalStart = 0;
    this.charCount = 0;
    this.spinnerIdx = 0;
    this.interval = null;
    this.stopped = false;
  }

  /** Begin the first phase */
  start(phase) {
    this.totalStart = Date.now();
    this._beginPhase(phase);
  }

  /** Switch to the next phase */
  nextPhase(phase) {
    this._endPhase();
    this._beginPhase(phase);
  }

  _beginPhase(phase) {
    this.phase = phase;
    this.phaseStart = Date.now();
    if (this.isTTY) {
      this._render();
      this.interval = setInterval(() => this._render(), 200);
    } else {
      this.stream.write(`${muted('[' + phase + '...]')} `);
    }
  }

  _render() {
    const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
    const spinner = SPINNER[this.spinnerIdx];
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER.length;
    // Loader line: accent spinner, muted phase, dimmed elapsed suffix.
    this.stream.write(`\r${accent(spinner)} ${muted(this.phase)} ${dim(ICON.dot + ' ' + elapsed + 's')}`);
  }

  _endPhase() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY && this.phase) {
      const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
      this.stream.write(`\r${success(ICON.ok)} ${muted(this.phase)} ${dim(ICON.dot + ' ' + elapsed + 's')}\n`);
    } else if (!this.isTTY && this.phase) {
      const elapsed = ((Date.now() - this.phaseStart) / 1000).toFixed(1);
      this.stream.write(`${dim(ICON.dot + ' ' + elapsed + 's')}\n`);
    }
    this.phase = null;
  }

  /**
   * Called on each delta: clears the spinner line so stdout streaming is clean.
   * Subsequent deltas just accumulate char count.
   */
  tick(text) {
    this.charCount += (text || '').length;
    if (this.stopped) return;
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.isTTY) {
      this.stream.write('\r\x1b[K');
    } else if (this.phase) {
      this.stream.write('\n');
    }
    this.phase = null;
  }

  /** All done — print final stats */
  done() {
    if (!this.stopped) {
      this._endPhase();
    }
    const totalElapsed = ((Date.now() - this.totalStart) / 1000).toFixed(1);
    this.stream.write(`${success(ICON.ok + ' done')} ${dim(ICON.dot)} ${muted(totalElapsed + 's, ' + this.charCount + ' chars')}\n`);
  }
}

export default ProgressIndicator;
