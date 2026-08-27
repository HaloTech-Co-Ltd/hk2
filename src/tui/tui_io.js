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
 * The TUI implementation of the ctx `io` prompt primitives (the counterpart
 * of replIo in session_ctx.js): every slash command's ctx.print / ctx.confirm /
 * ctx.choose renders through the Frame + ModalHost instead of readline.
 * Contract parity with the readline era: choose returns a 1-based index,
 * Esc/cancel resolves to the LAST option (the conservative skip), exactly
 * like replIo.choose's Ctrl+D behavior.
 */
export function makeTuiIo(frame, modalHost, { onCleared } = {}) {
  return {
    print: (text) => frame.writeLine(text),
    /**
     * Streaming partial-line output (slash commands rendering markdown /
     * reasoning live). Routes through the Frame — a raw process.stdout.write
     * here would land under the reserved input region and get overwritten by
     * the next redraw (the TUI's single-writer invariant).
     */
    write: (text) => frame.write(text),
    /** /clear hook: the TUI redraw the welcome card on a cleared screen. */
    onCleared: () => { if (onCleared) onCleared(); },
    confirm: async (promptText, { title } = {}) => {
      const r = await modalHost.open('confirm', { text: promptText, title });
      return r === true;
    },
    confirmThreeWay: (promptText, { title } = {}) =>
      modalHost.open('confirm', { text: promptText, threeWay: true, title }),
    choose: async (promptText, options = []) => {
      const n = options.length;
      if (n === 0) return null;
      const header = [String(promptText ?? '')];
      const rows = options.map((o, i) => ({ row: `  ${i + 1}. ${o}` }));
      const r = await modalHost.open('optionList', { header, options: rows });
      if (r === null) return n; // cancel → last option (conservative), replIo contract
      return r.index + 1;       // 1-based
    },
  };
}
