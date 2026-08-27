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
 * atomicfile写：写 tmp → rename，避免读到半写状态。
 *
 * Credential-bearing files (models.json holds API keys, projects.json can
 * carry them in phase options) default to owner-only permissions: the temp
 * file is created 0o600 and the mode is RE-APPLIED after the rename — a
 * bare rename preserves the temp file's mode, but a file the user once
 * chmod'ed wide (or one created by an older hk2 under a permissive umask)
  * must not keep those bits across a rewrite.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileAtomic(absPath, content, { mode = 0o600 } = {}) {
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
  await fs.writeFile(tmp, content, { mode });
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
    // Enforce the mode on the TARGET: the rename replaced whatever was
    // there (possibly 0644 from an older version or a permissive umask).
    await fs.chmod(absPath, mode).catch(() => {});
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(absPath, obj, opts) {
  return writeFileAtomic(absPath, JSON.stringify(obj), opts);
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
