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
 * dangerous applications, then you shall be responsible for taking all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Canonical key normalization for the TUI. readline's keypress events come
 * as (str, key) with inconsistent shapes across terminals; normalizeKey maps
 * them to ONE closed set of types so InputBox / ModalHost / the main key
 * loop all switch on the same vocabulary:
 *
 *   {type:'char', text}            printable text (may be a surrogate pair)
 *   {type:'left'|'right'|'up'|'down'}
 *   {type:'pageup'|'pagedown'}     menu paging (completion / history search)
 *   {type:'home'|'end'}
 *   {type:'enter'}                 submit (InputBox decides: submit vs continue)
 *   {type:'newline'}               forced newline (alt+enter / ctrl+j)
 *   {type:'backspace'|'delete'}
 *   {type:'tab'}                   completion accept (handled by the menu, not InputBox)
 *   {type:'escape'}                modal cancel > menu close > interrupt (caller precedence)
 *   {type:'ctrl', ch}              ctrl+letter (a/e/k/u/w/d/c/g/l/o/r/...)
 *   {type:'alt-backspace'}         delete word before cursor
 *   {type:'unknown'}
 */

const CTRL_NAMES = new Set(['a', 'b', 'd', 'e', 'f', 'g', 'k', 'n', 'o', 'p', 'r', 'u', 'w', 'c', 'h', 'l', 'j']);

export function normalizeKey(str, key = {}) {
  const name = key.name || '';
  const ctrl = !!key.ctrl;
  const meta = !!key.meta;

  if (name === 'paste-start') return { type: 'paste-start' };
  if (name === 'paste-end') return { type: 'paste-end' };

  if (name === 'return' || name === 'enter' || str === '\r' || str === '\n') {
    if (meta) return { type: 'newline' };
    if (ctrl) return { type: 'newline' }; // ctrl+j / ctrl+enter force a newline
    return { type: 'enter' };
  }
  if (name === 'backspace' || str === '\x7f' || (ctrl && name === 'h')) {
    return meta ? { type: 'alt-backspace' } : { type: 'backspace' };
  }
  if (name === 'delete') return { type: 'delete' };
  if (name === 'tab') return { type: 'tab' };
  if (name === 'escape' || str === '\x1b') return { type: 'escape' };
  if (name === 'left' || name === 'right' || name === 'up' || name === 'down') {
    return { type: name };
  }
  if (name === 'pageup') return { type: 'pageup' };
  if (name === 'pagedown') return { type: 'pagedown' };
  if (name === 'home') return { type: 'home' };
  if (name === 'end') return { type: 'end' };

  if (ctrl && !meta) {
    // ctrl+letter (and ctrl+p/n/b/f as arrow aliases). Prefer the decoded
    // key NAME — the raw sequence for ctrl combos is a control byte
    // (e.g. '\x03' for c), which is not a letter.
    const ch = (name && name.length === 1 ? name : (str && str.length === 1 ? str : '')).toLowerCase();
    if (name === 'p') return { type: 'up' };
    if (name === 'n') return { type: 'down' };
    if (name === 'b') return { type: 'left' };
    if (name === 'f') return { type: 'right' };
    if (CTRL_NAMES.has(ch)) return { type: 'ctrl', ch };
    return { type: 'unknown' };
  }
  if (meta && !ctrl && str && !name) {
    // alt+<char> — only alt-backspace is meaningful today
    if (str === '\x7f') return { type: 'alt-backspace' };
    return { type: 'unknown' };
  }
  if (typeof str === 'string' && str.length > 0 && !ctrl && !meta && str >= ' ') {
    return { type: 'char', text: str };
  }
  return { type: 'unknown' };
}
