/**
 * atomicfile写：写 tmp → rename，避免读到半写状态。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(absPath, content) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  // Create the temp file in the SAME directory as the target so that the
  // rename below stays on a single filesystem. Using os.tmpdir() instead
  // breaks with EXDEV (cross-device link not permitted) whenever the system
  // tmp dir and the target live on different mounts (e.g. /tmp on tmpfs).
  const tmp = path.join(
    dir,
    `.${path.basename(absPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await fs.writeFile(tmp, content);
  try {
    try {
      await fs.rename(tmp, absPath);
    } catch (err) {
      // rename(2) is only atomic within a single filesystem. Even though we
      // place the temp file next to the target, an EXDEV can still occur on
      // exotic setups (e.g. the target dir is itself a bind-mount boundary or
      // an overlayfs node). Fall back to copy-then-unlink, which works across
      // filesystems at the cost of being non-atomic. This guarantees the
      // write completes instead of crashing the app.
      if (err.code !== 'EXDEV') throw err;
      await fs.copyFile(tmp, absPath);
      await fs.unlink(tmp).catch(() => {});
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(absPath, obj) {
  return writeFileAtomic(absPath, JSON.stringify(obj));
}

export async function readJson(absPath) {
  const txt = await fs.readFile(absPath, 'utf8');
  return JSON.parse(txt);
}

export async function readFileSafe(absPath, fallback = null) {
  try {
    return await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function readJsonSafe(absPath, fallback = null) {
  try {
    return await readJson(absPath);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function exists(absPath) {
  try { await fs.access(absPath); return true; } catch { return false; }
}

export async function rmrf(absPath) {
  await fs.rm(absPath, { recursive: true, force: true }).catch(() => {});
}
