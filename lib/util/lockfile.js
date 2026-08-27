/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * (License header identical to the rest of lib/ — see lib/util/fs_atomic.js)
 *
 *-------------------------------------------------------------------------*/

/**
 * Cross-process advisory lock via an O_EXCL lockfile (issue #7).
 *
 * models.json / projects.json were written read-modify-write with NO
 * inter-process mutual exclusion: two hk2 processes (two terminals, two
 * projects) could each load the full file, apply their own edit, and rename
 * their snapshot over the target — the loser's update silently vanished
 * (classic lost-update; writeFileAtomic only prevents torn reads, not
 * write-write races).
 *
 * Design:
 *   - LOCK FILE: `<target>.lock`, created with O_EXCL ("wx" — atomic on
 *     POSIX and Windows), containing JSON `{pid, ts}` so a stale lock
 *     (holder crashed or was kill -9'd) can be detected and taken over.
 *   - STALE DETECTION: a lock is stale when (a) its content is unreadable,
 *     (b) the recorded pid is not a live process, or (c) it is older than
 *     `staleMs` (default 30s — an upper bound on any legitimate hold; hk2
 *     writers hold for milliseconds). After unlinking a stale lock the
 *     normal O_EXCL race decides the next owner (whoever creates it first).
 *   - IN-PROCESS SERIALIZATION: a per-path promise chain makes concurrent
 *     withLock calls in the SAME process queue up instead of fighting each
 *     other over the lockfile.
 *   - RETRY: acquisition retries with exponential backoff (5ms → 40ms) up
 *     to `timeoutMs` (default 10s), then throws.
 *
 * The lock is advisory and best-effort: an FS without exclusive-create
 * semantics degrades to unlocked last-write-wins rather than blocking.
 */
import fsp from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-lockfile serialization chains: lockPath → tail promise. */
const chains = new Map();

function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: pure existence probe
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

/** Write-lock states returned by tryAcquire. */
const ACQUIRED = 'acquired';
const HELD = 'held';
const DEGRADED = 'degraded'; // FS can't do exclusive create — run unlocked

async function tryAcquire(lockPath) {
  let fd;
  try {
    fd = await fsp.open(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return HELD;
    // Filesystem / permission setup without exclusive-create semantics:
    // degrade to unlocked (advisory lock — proceed rather than deadlock).
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOSYS' || err.code === 'EINVAL') return DEGRADED;
    throw err;
  }
  try {
    await fd.write(JSON.stringify({ pid: process.pid, ts: Date.now() }));
  } finally {
    await fd.close();
  }
  return ACQUIRED;
}

async function isStale(lockPath, staleMs) {
  let st;
  try { st = await fsp.stat(lockPath); } catch { return false; } // gone → just absent
  try {
    const info = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    if (!info || typeof info !== 'object' || !Number.isFinite(info.pid)) return true;
    if (!processAlive(info.pid)) return true;
    if (Date.now() - (st.mtimeMs || 0) > staleMs) return true;
    return false;
  } catch { return true; } // unreadable → stale
}

/**
 * Run `fn` while holding the write lock for `targetPath` (lockfile at
 * `<targetPath>.lock`). Same-process callers serialize; cross-process
 * callers contend on the O_EXCL create. Returns fn's value.
 */
export async function withLock(targetPath, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  const lockPath = `${targetPath}.lock`;
  const prev = chains.get(lockPath) || Promise.resolve();
  let advanceChain;
  const chain = new Promise((res) => { advanceChain = res; });
  chains.set(lockPath, chain);
  let degraded = false;
  try {
    await prev.catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let delay = 5;
    for (;;) {
      const state = await tryAcquire(lockPath);
      if (state === DEGRADED) {
        // No lock support: run unlocked once (best-effort advisory).
        degraded = true;
        break;
      }
      if (state === ACQUIRED) break;
      // HELD by someone else — steal it if provably stale.
      if (await isStale(lockPath, staleMs)) {
        await fsp.unlink(lockPath).catch(() => {});
        continue; // next loop: O_EXCL race decides the new owner
      }
      if (Date.now() + delay > deadline) {
        throw new Error(`lock timeout after ${timeoutMs}ms waiting for ${lockPath}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 40);
    }
    return await fn();
  } finally {
    if (!degraded) await fsp.unlink(lockPath).catch(() => {});
    advanceChain();
    if (chains.get(lockPath) === chain) chains.delete(lockPath);
  }
}

export default withLock;
