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
import { projectSessionPath, SESSIONS_ROOT } from '../config/home.js';

export class Transcript {
  constructor(projectId, sessionId) {
    // sessionId may be undefined (caller wants a fresh generated UUID) —
    // that is the reloadAll path. Only a PROVIDED id must be a valid flat
    // token; anything else (traversal, paths, junk) throws.
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
      throw new Error(`invalid session id: ${JSON.stringify(String(sessionId).slice(0, 32))}`);
    }
    this.projectId = projectId;
    this.sessionId = sessionId || randomUUID();
    this.path = projectSessionPath(projectId, this.sessionId);
    this.startedAt = new Date().toISOString();
    this._ensure = null;
    // Serialize appends through a promise chain: callers don't always await
    // (e.g. interactive.js onToolCallEnd fires logToolCall without await), and
    // O_APPEND atomicity is only guaranteed up to PIPE_BUF (~4KB) — a large
    // tool_call result could otherwise interleave with a concurrent append.
    this._tail = Promise.resolve();
  }

  async _init() {
    if (this._ensure) return this._ensure;
    this._ensure = (async () => {
      await fs.mkdir(path.dirname(this.path), { recursive: true });
      const line = JSON.stringify({
        ts: this.startedAt,
        type: 'session_start',
        sessionId: this.sessionId,
        projectId: this.projectId,
      }) + '\n';
      // APPEND semantics, not replace. writeFileAtomic renames a temp file
      // OVER the target — the old _init/append clobbered the transcript down
      // to its last line on every write, so 0 kb-stats / usage records ever
      // landed on disk even after the v2 fix moved the logMeta call out of
      // the render try/catch (the persistence bug was one layer below). For a
      // fresh session the file doesn't exist yet so writeFileAtomic is still
      // fine (create-exactly-once); for a RESUMED session (same sessionId
      // reused) we must append so prior history survives.
      let exists = false;
      try { await fs.access(this.path); exists = true; } catch { exists = false; }
      if (exists) await fs.appendFile(this.path, line);
      else await writeFileAtomic(this.path, line);
    })();
    return this._ensure;
  }

  async append(event) {
    await this._init();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    // Chained fs.appendFile (O_APPEND): every event lands as its own line,
    // nothing is clobbered. Serialized via _tail so un-awaited callers can't
    // interleave partial writes on lines larger than PIPE_BUF.
    const job = this._tail.catch(() => {}).then(() => fs.appendFile(this.path, line));
    this._tail = job;
    await job;
  }

  /**
   * Resolves once every append issued so far has landed on disk (the append
   * chain is serialized via _tail; callers that fire-and-forget an event can
   * await this before process.exit so the last lines are never truncated).
   */
  flush() {
    return this._tail.catch(() => {});
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

/**
 * Replay a transcript's JSONL text back into an LLM-ready `messages` array.
 *
 * The transcript stores a flat event stream (user / assistant / tool_call),
 * NOT the exact assistant-with-tool_calls + role:tool message pairs the agent
 * loop keeps in memory. This function reconstructs those pairs so a resumed
 * session feeds the LLM the same message shapes loop.js produces:
 *
 *   user "..."
 *   assistant { content: '', tool_calls: [A, B] }   ← synthesized from the
 *   tool      { tool_call_id: A, ... }                 consecutive tool_call
 *   tool      { tool_call_id: B, ... }                 event run
 *   assistant "final aggregated text"
 *
 * Consecutive tool_call events are grouped into ONE synthesized assistant
 * message even when they spanned multiple internal loop rounds (the flat
 * transcript cannot tell the rounds apart); the grouped shape is still valid
 * OpenAI/Anthropic tool protocol and semantically equivalent.
 *
 * Events that are NOT part of LLM history (session_start / turn_end / meta /
 * system_prompt) are skipped: the system prompt is rebuilt fresh on the next
 * turn (its tool list must reflect the CURRENT session), and per-turn KB
 * context injections are regenerated per request anyway.
 *
 * @param {string} text raw JSONL file content
 * @returns {{ messages: Array, lastUserText: string|null, firstTs: string|null, lastTs: string|null }}
 */
export function replayTranscript(text) {
  const messages = [];
  let pending = [];        // consecutive tool_call events awaiting grouping
  let lastUserText = null;
  let firstTs = null;
  let lastTs = null;

  const flushTools = () => {
    if (pending.length === 0) return;
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: pending.map(c => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
        },
      })),
    });
    for (const c of pending) {
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        name: c.name,
        // logToolCall stores `result: ok ? result.result : { error }` — the
        // same envelope loop.js JSON.stringifies into role:tool content.
        content: JSON.stringify(c.result ?? { error: 'result missing from transcript' }),
      });
    }
    pending = [];
  };

  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.ts) {
      if (!firstTs) firstTs = evt.ts;
      lastTs = evt.ts;
    }
    switch (evt.type) {
      case 'user': {
        flushTools();
        const t = String(evt.text ?? '');
        messages.push({ role: 'user', content: t });
        lastUserText = t;
        break;
      }
      case 'assistant': {
        flushTools();
        // Empty assistant texts (interrupted before any body delta) would
        // produce a contentless trailing assistant message — skip those.
        if (typeof evt.text === 'string' && evt.text.length > 0) {
          messages.push({ role: 'assistant', content: evt.text });
        }
        break;
      }
      case 'tool_call':
        pending.push(evt);
        break;
      default:
        // session_start / turn_end / meta / system_prompt → not LLM history
        break;
    }
  }
  // A turn interrupted mid-tool-loop leaves trailing tool_call events with
  // no aggregated assistant text after them — still replay them so the LLM
  // sees what was already tried.
  flushTools();

  return { messages, lastUserText, firstTs, lastTs };
}

/**
 * Find the most recently modified session id for a project.
 *
 * Used by `hk2 --resume` (bare) and `/session resume` (no id) to reopen the
 * project's latest session. `exclude` skips an id (e.g. the session a live
 * REPL is already writing to). `root` overrides the sessions root for tests.
 *
 * @returns {Promise<string|null>} session id, or null when none exist
 */
export async function findLatestSessionId(projectId, { exclude, requireContent = false, root } = {}) {
  if (!projectId) return null;
  const dir = path.join(root || SESSIONS_ROOT, projectId);
  let entries;
  try { entries = await fs.readdir(dir); } catch { return null; }
  const files = [];
  for (const ent of entries) {
    if (!ent.endsWith('.jsonl')) continue;
    const id = ent.slice(0, -'.jsonl'.length);
    if (exclude && id === exclude) continue;
    const st = await fs.stat(path.join(dir, ent)).catch(() => null);
    if (!st) continue;
    files.push({ id, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!requireContent) return files.length > 0 ? files[0].id : null;
  // Skip sessions with no user content: every boot creates a fresh
  // transcript BEFORE the user says anything, and a quit-without-messages
  // leaves that empty file as the NEWEST — a bare --resume or the exit hint
  // would then point at an empty conversation. Cheap check: the file only
  // has content if it ever logged a user event.
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, `${f.id}.jsonl`), 'utf8').catch(() => '');
    if (raw.includes('"type":"user"')) return f.id;
  }
  return null;
}

/**
 * The session id worth resuming once THIS process exits — the session
 * lifecycle fix for the quit-without-messages case. An empty transcript
 * (created eagerly at boot, never got a user line) is DELETED (this process
 * owns it — no concurrency concern) and the hint falls back to the newest
 * session that actually has content; a transcript with content keeps its
 * own id. Returns null when there is nothing worth resuming.
 */
export async function resumeHintAfterExit(transcript) {
  if (!transcript?.path || !transcript.projectId) return null;
  const raw = await fs.readFile(transcript.path, 'utf8').catch(() => '');
  if (raw.includes('"type":"user"')) return transcript.sessionId;
  await fs.unlink(transcript.path).catch(() => {});
  try {
    return await findLatestSessionId(transcript.projectId, {
      exclude: transcript.sessionId,
      requireContent: true,
    });
  } catch { return null; }
}

/**
 * Find a session transcript by id across ALL projects' session dirs
 * (~/.hk2/sessions/<projectId>/<sessionId>.jsonl). Returns the owning
 * projectId, or null when no such session exists anywhere.
 *
 * Why: sessions live per-project, but `--resume <id>` should not fail just
 * because the project was dropped (/project drop) after the hint was
 * printed — the transcript on disk is still perfectly resumable.
 */
export async function findSessionProject(sessionId, { root } = {}) {
  if (!isValidSessionId(sessionId)) return null;
  const base = root || SESSIONS_ROOT;
  let projects;
  try { projects = await fs.readdir(base); } catch { return null; }
  for (const pid of projects) {
    const p = path.join(base, pid, sessionId + '.jsonl');
    try { await fs.stat(p); return pid; } catch {}
  }
  return null;
}

/**
 * A session id is a flat token (UUID or word) naming a .jsonl inside a
 * project's sessions dir. Anything that could traverse out of it — ../,
 * slashes, backslashes, dotfiles, overlong junk — is invalid, everywhere,
 * at every entry point (CLI --resume, /resume, /session resume|info).
 */
export function isValidSessionId(id) {
  return typeof id === 'string'
    && id.length > 0
    && id.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);
}

export default Transcript;
