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
 * /session command family — session management.
 *
 * Usage:
 *   /session info                Show current session id, project, message count
 *   /session list [--limit=N]    List recent sessions for the current project
 *   /session new                 Start a new session (fresh transcript)
 *   /session resume <id>         Resume a previous session by id
 *   /session compact             Manually compact the conversation (alias for /compact)
 *
 * Sessions are stored as JSONL at ~/.hk2/sessions/<projectId>/<sessionId>.jsonl.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../../lib/util/fs_atomic.js';
import { SESSIONS_ROOT } from '../../lib/config/home.js';
import { printCommandHelp } from './help.js';

export async function cmdSession(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'info': case undefined: return sessionInfo(ctx);
    case 'list': case 'ls': return sessionList(rest, ctx);
    case 'new': return sessionNew(ctx);
    case 'resume': return sessionResume(rest, ctx);
    case 'compact': await ctx.compactConversation?.(); return;
    case 'help': case '?':
      printCommandHelp(ctx, 'session');
      return;
    default:
      ctx.print(`Unknown /session subcommand: ${sub}`);
      printCommandHelp(ctx, 'session');
  }
}

async function sessionInfo(ctx) {
  const info = ctx.getSessionInfo?.();
  if (!info) {
    ctx.print(`No active session.`);
    return;
  }
  ctx.print(`Session:    ${info.sessionId}`);
  ctx.print(`Project:    ${info.projectName || '(none)'} (${info.projectId || '?'})`);
  ctx.print(`Started:    ${info.startedAt || '?'}`);
  ctx.print(`Messages:   ${info.messageCount}`);
  ctx.print(`Tools:      ${info.toolCalls} calls`);
  if (info.path) ctx.print(`Transcript: ${info.path}`);
}

async function sessionList(rest, ctx) {
  const flags = parseFlags(rest);
  const limit = parseInt(flags.limit, 10) || 20;
  const info = ctx.getSessionInfo?.();
  if (!info?.projectId) {
    ctx.print(`No current project.`);
    return;
  }
  const dir = path.join(SESSIONS_ROOT, info.projectId);
  if (!await exists(dir)) {
    ctx.print(`(no sessions yet)`);
    return;
  }
  const entries = await fs.readdir(dir);
  const sessions = [];
  for (const ent of entries) {
    if (!ent.endsWith('.jsonl')) continue;
    const p = path.join(dir, ent);
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) continue;
    sessions.push({
      id: ent.replace(/\.jsonl$/, ''),
      path: p,
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const slice = sessions.slice(0, limit);
  if (slice.length === 0) {
    ctx.print(`(no sessions yet)`);
    return;
  }
  ctx.print(`Found ${sessions.length} session(s), showing latest ${slice.length}:`);
  for (const s of slice) {
    const dt = new Date(s.mtime).toISOString().replace('T', ' ').slice(0, 19);
    const cur = s.id === info.sessionId ? '*' : ' ';
    ctx.print(`${cur} ${s.id}  ${dt}  ${(s.size / 1024).toFixed(1)}KB`);
  }
}

async function sessionNew(ctx) {
  await ctx.newSession?.();
  ctx.print(`New session started.`);
}

async function sessionResume(rest, ctx) {
  const id = rest[0];
  if (!id) {
    ctx.print(`Usage: /session resume <sessionId>`);
    return;
  }
  const ok = await ctx.resumeSession?.(id);
  if (!ok) ctx.print(`Session not found: ${id}`);
}

function parseFlags(tokens) {
  const out = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) out[t.slice(2, eq)] = t.slice(eq + 1);
      else out[t.slice(2)] = true;
    }
  }
  return out;
}
