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
