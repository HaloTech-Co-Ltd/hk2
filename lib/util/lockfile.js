/*-------------------------------------------------------------------------
 *
 * 版权所有 (c) 2019-2026, 易景科技保留所有权利。
 * Copyright (c) 2019-2026, Halo Tech Co.,Ltd. All rights reserved.
 *
 * (License header identical to the rest of lib/ — see lib/util/fs_atomic.js)
 *
 *-------------------------------------------------------------------------*/

/**
 * Cross-process advisory lock via an atomically published lockfile (issue #7).
 *
 * models.json / projects.json were written read-modify-write with NO
 * inter-process mutual exclusion: two hk2 processes (two terminals, two
 * projects) could each load the full file, apply their own edit, and rename
 * their snapshot over the target — the loser's update silently vanished
 * (classic lost-update; writeFileAtomic only prevents torn reads, not
 * write-write races).
 *
 * Design:
 *   - LOCK FILE: `<target>.lock`, published by hard-linking a fully written
 *     sibling temp file, containing JSON `{pid, ts, token}` so a stale lock
 *     (holder crashed or was kill -9'd) can be detected and taken over.
 *   - STALE DETECTION: a valid lock is stale when its recorded pid is no
 *     longer live or the pid now belongs to a different process incarnation.
 *     Malformed/legacy locks are reclaimed only after `staleMs`; fresh
 *     unreadable metadata is never assumed abandoned.
 *   - OWNERSHIP: release checks the random token, so a waiter that times out
 *     or an old owner whose lock was replaced cannot unlink another owner.
 *     Stale recovery is serialized by a sibling `.reap` directory with its
 *     own owner metadata; abandoned recovery gates are themselves recoverable.
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
import { randomUUID } from 'node:crypto';

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

/** Linux process start tick, used to distinguish a live owner from PID reuse. */
async function processStartIdentity(pid) {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    // Fields after the command start at field 3 (state); starttime is field 22.
    return stat.slice(close + 2).trim().split(/\s+/)[19] || null;
  } catch {
    // Non-Linux platforms do not expose /proc. The pid + age fallback below
    // retains portable behavior, while Linux gets exact PID-reuse detection.
    return null;
  }
}

async function ownerMetadata(token) {
  return {
    pid: process.pid,
    ts: Date.now(),
    token,
    processStart: await processStartIdentity(process.pid),
  };
}

/** Write-lock states returned by tryAcquire. */
const ACQUIRED = 'acquired';
const HELD = 'held';
const DEGRADED = 'degraded'; // FS can't do exclusive create — run unlocked

async function tryAcquire(lockPath) {
  // A stale-lock reaper keeps this gate directory present while it validates
  // and removes the old owner. Do not publish a new owner until that atomic
  // handoff is complete.
  try {
    await fsp.stat(`${lockPath}.reap`);
    return HELD;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = `${process.pid}-${randomUUID()}`;
  const tempPath = `${lockPath}.${token}.tmp`;
  try {
    // Publish a fully initialized inode atomically. Creating lockPath first
    // exposed an empty/partial JSON window that contenders mistook for stale.
    await fsp.writeFile(tempPath, JSON.stringify(await ownerMetadata(token)), {
      flag: 'wx', mode: 0o600,
    });
    await fsp.link(tempPath, lockPath);
  } catch (err) {
    if (err.code === 'EEXIST') return HELD;
    // Filesystem / permission setup without exclusive-create semantics:
    // degrade to unlocked (advisory lock — proceed rather than deadlock).
    if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOSYS' || err.code === 'EINVAL') return DEGRADED;
    throw err;
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
  return { state: ACQUIRED, token };
}

async function isMetadataStale(statPath, metadataPath, staleMs) {
  let st;
  try { st = await fsp.stat(statPath); } catch { return false; } // gone → just absent
  try {
    const info = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
    if (!info || typeof info !== 'object' || !Number.isFinite(info.pid)) {
      return Date.now() - (st.mtimeMs || 0) > staleMs;
    }
    if (!processAlive(info.pid)) return true;
    if (typeof info.processStart === 'string' && info.processStart) {
      const currentStart = await processStartIdentity(info.pid);
      if (currentStart && currentStart !== info.processStart) return true;
      return false;
    }
    // Legacy/non-/proc metadata cannot disambiguate PID reuse. Preserve fresh
    // live locks, but retain the historical lease bound for eventual recovery.
    return Date.now() - (st.mtimeMs || 0) > staleMs;
  } catch {
    // A malformed legacy lock may be left by a crashed older process. Never
    // reclaim a fresh unreadable file: it could still be initializing.
    return Date.now() - (st.mtimeMs || 0) > staleMs;
  }
}

const isStale = (lockPath, staleMs) => isMetadataStale(lockPath, lockPath, staleMs);

async function releaseOwned(lockPath, token) {
  if (!token) return;
  try {
    const info = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    if (info?.token === token) await fsp.unlink(lockPath);
  } catch { /* already gone, unreadable, or replaced by another owner */ }
}

async function recoverStaleReap(lockPath, staleMs) {
  const reapPath = `${lockPath}.reap`;
  const ownerPath = `${reapPath}/owner.json`;
  let exists = true;
  try { await fsp.stat(reapPath); } catch (err) {
    if (err.code === 'ENOENT') exists = false;
    else throw err;
  }
  if (!exists || !await isMetadataStale(reapPath, ownerPath, staleMs)) return false;

  // Rename is the ownership claim: only one contender can move this exact
  // stale gate away. A concurrently created replacement remains at reapPath.
  const tombstone = `${reapPath}.${process.pid}-${randomUUID()}.stale`;
  try {
    await fsp.rename(reapPath, tombstone);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EEXIST' || err.code === 'ENOTEMPTY') return false;
    throw err;
  }
  await fsp.rm(tombstone, { recursive: true, force: true });
  return true;
}

async function acquireReap(lockPath) {
  const reapPath = `${lockPath}.reap`;
  const token = `${process.pid}-${randomUUID()}`;
  try {
    await fsp.mkdir(reapPath, { mode: 0o700 });
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    await fsp.writeFile(`${reapPath}/owner.json`, JSON.stringify(await ownerMetadata(token)), {
      flag: 'wx', mode: 0o600,
    });
    return token;
  } catch (err) {
    await fsp.rm(reapPath, { recursive: true, force: true });
    throw err;
  }
}

async function releaseReap(lockPath, token) {
  if (!token) return;
  const reapPath = `${lockPath}.reap`;
  try {
    const info = JSON.parse(await fsp.readFile(`${reapPath}/owner.json`, 'utf8'));
    if (info?.token === token) await fsp.rm(reapPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function reapIfStale(lockPath, staleMs) {
  const token = await acquireReap(lockPath);
  if (!token) return false;
  try {
    // Recheck after winning the recovery gate. Another contender may have
    // replaced the lock since our first observation.
    if (!await isStale(lockPath, staleMs)) return false;
    await fsp.unlink(lockPath).catch(err => {
      if (err.code !== 'ENOENT') throw err;
    });
    return true;
  } finally {
    await releaseReap(lockPath, token);
  }
}

/**
 * Run `fn` while holding the write lock for `targetPath` (lockfile at
 * `<targetPath>.lock`). Same-process callers serialize; cross-process
 * callers contend on atomic publication of the lock path. Returns fn's value.
 */
export async function withLock(targetPath, fn, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  const lockPath = `${targetPath}.lock`;
  const prev = chains.get(lockPath) || Promise.resolve();
  let advanceChain;
  const chain = new Promise((res) => { advanceChain = res; });
  chains.set(lockPath, chain);
  let degraded = false;
  let acquiredToken = null;
  try {
    await prev.catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let delay = 5;
    for (;;) {
      await recoverStaleReap(lockPath, staleMs);
      const acquired = await tryAcquire(lockPath);
      const state = typeof acquired === 'object' ? acquired.state : acquired;
      if (state === DEGRADED) {
        // No lock support: run unlocked once (best-effort advisory).
        degraded = true;
        break;
      }
      if (state === ACQUIRED) {
        acquiredToken = acquired.token;
        break;
      }
      // HELD by someone else — steal it if provably stale.
      if (await isStale(lockPath, staleMs) && await reapIfStale(lockPath, staleMs)) {
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
    if (!degraded) await releaseOwned(lockPath, acquiredToken);
    advanceChain();
    if (chains.get(lockPath) === chain) chains.delete(lockPath);
  }
}

export default withLock;
