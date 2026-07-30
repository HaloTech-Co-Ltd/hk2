/**
 * Resumable build checkpoint.
 *
 * Path: ~/.hk2/kb/<kbName>/checkpoint.json
 *
 * Format:
 *   {
 *     phase: 'parse' | 'done',
 *     processedFiles: [{ path, hash }, ...],
 *     lastSavedAt: ISO,
 *     interval: number
 *   }
 *
 * Lifecycle:
 *   await cp.load()           # reads existing checkpoint (if any)
 *   cp.has(path, hash)        # true if this exact file was already processed
 *   await cp.markDone(path, hash)
 *   await cp.saveIfDue(cb)    # saves every `interval` markDone calls
 *   await cp.finalize()       # always flushes (does NOT clear)
 *   await cp.clear()          # deletes the checkpoint file (on success)
 *
 * The indexer calls load → loop(markDone+saveIfDue) → finalize → ...
 * → clear on success. If the process is killed mid-loop, the next run
 * resumes by skipping files present in `processedFiles` with matching hash.
 */

import path from 'node:path';
import { writeJsonAtomic, readJsonSafe, exists, rmrf } from '../util/fs_atomic.js';
import { kbDir } from '../store/kb_store.js';

export function checkpointPath(name) {
  return path.join(kbDir(name), 'checkpoint.json');
}

export class Checkpoint {
  /**
   * @param {string} kbName
   * @param {{ interval?: number, enabled?: boolean }} [opts]
   */
  constructor(kbName, opts = {}) {
    this.kbName = kbName;
    this.interval = opts.interval ?? 100;
    this.enabled = opts.enabled !== false;
    /** @type {Map<string, string>} path → hash */
    this.processed = new Map();
    this.phase = 'parse';
    this._counter = 0;
    this._loaded = false;
  }

  async load() {
    if (!this.enabled || this._loaded) return;
    this._loaded = true;
    const cp = await readJsonSafe(checkpointPath(this.kbName), null);
    if (!cp || !Array.isArray(cp.processedFiles)) return;
    for (const { path: p, hash } of cp.processedFiles) {
      if (p && hash) this.processed.set(p, hash);
    }
    this.phase = cp.phase || 'parse';
  }

  has(filePath, hash) {
    return this.processed.has(filePath) && this.processed.get(filePath) === hash;
  }

  async markDone(filePath, hash) {
    if (!this.enabled) return;
    this.processed.set(filePath, hash);
    this._counter++;
  }

  async saveIfDue(onSave) {
    if (!this.enabled) return;
    if (this._counter < this.interval) return;
    await this._write();
    this._counter = 0;
    if (onSave) onSave();
  }

  async finalize() {
    if (!this.enabled) return;
    await this._write();
  }

  async clear() {
    if (!this.enabled) return;
    const p = checkpointPath(this.kbName);
    if (await exists(p)) await rmrf(p);
    this.processed.clear();
    this._counter = 0;
  }

  async _write() {
    const data = {
      phase: this.phase,
      processedFiles: Array.from(this.processed.entries()).map(([path, hash]) => ({ path, hash })),
      lastSavedAt: new Date().toISOString(),
      interval: this.interval,
    };
    await writeJsonAtomic(checkpointPath(this.kbName), data);
  }

  get size() { return this.processed.size; }
}
