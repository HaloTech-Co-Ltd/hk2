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
import { SESSIONS_ROOT, getCurrentProject } from '../../lib/config/home.js';

export async function cmdSession(args, ctx) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'info': case undefined: return sessionInfo(ctx);
    case 'list': case 'ls': return sessionList(rest, ctx);
    case 'new': return sessionNew(ctx);
    case 'resume': return sessionResume(rest, ctx);
    case 'compact': await ctx.compactConversation?.(); return;
    default:
      ctx.print(`/session subcommands: info | list | new | resume | compact`);
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
