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
 * dangerous applications, then you shall be responsible to take all
 * appropriate fail-safe, backup, redundancy, and other measures to ensure
 * its safe use. Halo Corporation and its affiliates disclaim any
 * liability for any damages caused by use of this software in
 * dangerous applications.
 *
 *-------------------------------------------------------------------------
 */

/**
 * Shared tool-call card rendering — the exact bytes interactive.js emitted
 * before the extraction, parameterized by the writer so both front-ends use
 * one implementation: the REPL writes straight to process.stderr, the TUI
 * writes through its Frame (which parks the workspace cursor first; the
 * cursor-relative grow-redraw \x1b[2A\x1b[J is valid in both because the
 * writer always leaves the cursor right below the header it just wrote).
 */
import * as style from '../../lib/agent/style.js';
import { toolCardToken } from '../../lib/agent/tool_theme.js';
import { safeParseArgs, cardWidthFor, toolHeader } from './status_format.js';

/** Open a card: blank line, top border (tool name as title), header line. */
export function writeToolCardStart(write, call, args) {
  const token = toolCardToken(call.name);
  const header = toolHeader(call.name, args, token);
  const w = cardWidthFor([header], call.name);
  write('\n');
  write(style.topBorder(call.name, { width: w, token }) + '\n');
  write(style.bodyLine(header, { width: w, token }) + '\n');
}

/**
 * Close a card: ≤6 dim body lines (200-char truncated) + ok/failed row +
 * bottom border. When the body needs more width than the start predicted,
 * the cursor is moved 2 lines up (top border + header), the screen cleared
 * below, and the whole card redrawn at the wider width so borders match and
 * no body character is truncated.
 */
export function writeToolCardEnd(write, call, result) {
  const args = typeof call.arguments === 'string' ? safeParseArgs(call.arguments) : (call.arguments || {});
  const token = toolCardToken(call.name);
  const header = toolHeader(call.name, args, token);
  const previewText = JSON.stringify(result.ok ? result.result : { error: result.error });
  const maxLines = 6;
  const bodyLines = [];
  const chunks = previewText.split('\\n');
  const joined = chunks.slice(0, maxLines);
  for (const ln of joined) {
    const truncated = ln.length > 200 ? ln.slice(0, 200) + '…' : ln;
    bodyLines.push(style.dim(truncated));
  }
  if (chunks.length > maxLines) {
    bodyLines.push(style.dim(`… ${chunks.length - maxLines} more lines`));
  }
  const statusLine = result.ok
    ? `${style.success(style.ICON.ok)} ${style.dim('ok')}`
    : `${style.errorT(style.ICON.err)} ${style.errorT('failed')}`;
  bodyLines.push(statusLine);
  const w = cardWidthFor([header, ...bodyLines], call.name);
  const startW = cardWidthFor([header], call.name);
  if (w > startW) {
    write('\x1b[2A\x1b[J');
    write(style.topBorder(call.name, { width: w, token }) + '\n');
    write(style.bodyLine(header, { width: w, token }) + '\n');
  }
  for (const ln of bodyLines) {
    write(style.bodyLine(ln, { width: w, token }) + '\n');
  }
  write(style.bottomBorder({ width: w, token }) + '\n');
}

/**
 * SAFE serialization of a tool result for display: never throws, never
 * returns undefined. Covers undefined/null results, BigInt values (JSON
 * throws on them), and circular references (JSON throws) — a tool result
 * comes from arbitrary tool code and the renderer must not crash on exotic
 * shapes.
 */
export function fullResultText(r) {
  if (r === undefined) return 'undefined';
  if (r === null) return 'null';
  try {
    const s = JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v.toString()}n` : v));
    if (s !== undefined) return s;
  } catch { /* circular / exotic — fall through to a lossy but safe form */ }
  try { return JSON.stringify(String(r)); } catch { return '"[unserializable]"'; }
}

/**
 * User-facing tool name for the compact TUI line: internal ids never surface
 * verbatim. 'kb_search' → 'KB Search', 'plan_step' → 'Plan Step',
 * 'mcp__github__create_issue' → 'MCP: github/create_issue'.
 */
function toolDisplayName(name) { return String(name || '?'); }

/**
 * COMPACT tool line for the TUI (Claude Code's turn style):
 *   ● Bash(echo hi)
 *     ⎿  <first meaningful result line>
 * Reuses toolHeader's per-tool argument picking, but renders the Claude
 * bullet + display-name tool label + parenthesized argument instead of a
 * bordered card. The REPL keeps the card (writeToolCardStart/End).
 */
export function compactToolHeader(name, args) {
  const label = toolDisplayName(name);
  let arg = '';
  if (args && typeof args === 'object') {
    arg = args.command ?? args.path ?? args.pattern ?? args.query ?? args.name
      ?? args.symbol_id ?? args.id ?? '';
  }
  const shown = String(arg).length > 60 ? String(arg).slice(0, 57) + '…' : String(arg);
  return style.accent(style.ICON.bullet === '•' ? '●' : '*') + ' '
    + style.bold(label) + (shown ? style.dim(`(${shown})`) : '');
}

/**
 * The indented result line under a compact tool header: the first
 * meaningful line of the result (bash stdout first; generic results their
 * serialized first line via the SAFE serializer), with a "+N lines" hint.
 * Failed calls render the error in the error color.
 */
export function compactToolResult(name, result) {
  const hook = style.HAS_UTF8 ? '  ⎿  ' : '  > ';
  let text = '';
  let more = 0;
  if (result && result.ok) {
    const r = result.result;
    if (r && typeof r === 'object' && typeof r.stdout === 'string') {
      const lines = r.stdout.split('\n').filter(Boolean);
      text = lines[0] ?? '';
      more = Math.max(0, lines.length - 1);
      if (!text && r.stderr) text = r.stderr.split('\n')[0];
    } else {
      const lines = fullResultText(r).split('\\n');
      text = (lines[0] || '').slice(0, 90);
      more = lines.length - 1;
    }
  } else {
    const err = result?.error ?? 'failed';
    // Non-string errors (thrown objects, {code,message}) render their
    // message instead of '[object Object]'.
    const errText = err && typeof err === 'object'
      ? (err.message || fullResultText(err))
      : String(err);
    text = `Error: ${errText}`;
    return hook + style.errorT(text);
  }
  let line = hook + style.muted(text.length > 90 ? text.slice(0, 87) + '…' : text);
  if (more > 0) line += style.dim(`  … +${more} line${more > 1 ? 's' : ''}`);
  return line;
}
