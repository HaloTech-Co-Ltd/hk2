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
 * KB registration and lifecycle management.
 *
 * Per-project KB lives at ~/.hk2/kb/<projectId>/. The project record in
 * projects.json is the source of truth — there is no separate kb registry.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  kbDir, createKbDir, deleteKb, saveMeta, getMeta, readStats, KB_LAYOUT_VERSION,
} from '../store/kb_store.js';
import { exists } from '../util/fs_atomic.js';
import { ensureSupremeCode } from '../store/supreme_code.js';
import { DEFAULT_INCLUDE_GLOBS, DEFAULT_EXCLUDE_GLOBS, updateProject } from '../config/home.js';
import log from '../util/log.js';

export const PARSER_VERSION = 2;

const DEFAULT_INCLUDE = DEFAULT_INCLUDE_GLOBS;
// Snapshot of the pre-deep-parse default include list (40 globs, no
// sgml/pdf/office formats). Used to detect legacy projects whose
// includeGlobs were frozen from this old default so /kb init can upgrade
// them automatically — WITHOUT touching projects that set custom globs.
const LEGACY_DEFAULT_INCLUDE = [
  '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.hpp', '**/*.cxx',
  '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.ts', '**/*.tsx',
  '**/*.py', '**/*.go', '**/*.rs', '**/*.java', '**/*.kt', '**/*.scala',
  '**/*.rb', '**/*.php', '**/*.swift',
  '**/*.sh', '**/*.bash', '**/*.zsh',
  '**/*.y', '**/*.l',
  '**/*.md', '**/*.markdown', '**/*.txt', '**/*.rst', '**/*.adoc',
  '**/README*', '**/LICENSE*', '**/CHANGELOG*', '**/CONTRIBUTING*',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.html', '**/*.htm',
];
const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/target/**',
  '**/.venv/**', '**/vendor/**', '**/__pycache__/**',
  '**/.git/**', '**/.svn/**', '**/.hg/**',
  '**/.idea/**', '**/.vscode/**', '**/.DS_Store',
];

/**
 * Create/overwrite a KB directory and meta.json for a project record.
 *
 * @param {object} project  {id, name, sourcePath, sourceRoot, includeGlobs, excludeGlobs, extraRoots}
 */
export async function addKbForProject(project) {
  if (!project || !project.id) throw new Error('project.id required');
  if (!project.sourcePath) throw new Error('project.sourcePath required');
  const absSource = path.resolve(project.sourcePath);
  if (!await exists(absSource)) throw new Error(`source path not found: ${absSource}`);
  const sourceRoot = project.sourceRoot || '';
  const rootAbs = sourceRoot ? path.join(absSource, sourceRoot) : absSource;
  if (!await exists(rootAbs)) throw new Error(`source root not found: ${rootAbs}`);

  const includeGlobs = project.includeGlobs && project.includeGlobs.length
    ? project.includeGlobs
    : DEFAULT_INCLUDE;
  const excludeGlobs = project.excludeGlobs && project.excludeGlobs.length
    ? project.excludeGlobs
    : DEFAULT_EXCLUDE;

  // Self-heal legacy projects: when includeGlobs is EXACTLY the old 40-glob
  // default (frozen at /project init time before doc formats were added),
  // transparently upgrade it to the current default so PDF/Word/PPT/SGML
  // documents enter the index. Projects with custom globs are never touched.
  const isLegacyDefault = project.includeGlobs
    && project.includeGlobs.length === LEGACY_DEFAULT_INCLUDE.length
    && project.includeGlobs.every((g, i) => g === LEGACY_DEFAULT_INCLUDE[i]);
  let effectiveInclude = includeGlobs;
  if (isLegacyDefault) {
    effectiveInclude = DEFAULT_INCLUDE;
    try {
      await updateProject(project.id, { includeGlobs: DEFAULT_INCLUDE });
      log.info(`KB ${project.id}: upgraded legacy default includeGlobs (+sgml/pdf/doc/docx/ppt/pptx)`);
    } catch (err) {
      log.warn(`KB ${project.id}: failed to persist includeGlobs upgrade`, { msg: err.message });
    }
  }

  await createKbDir(project.id);
  // Every project's Holy space carries a permanent, empty-on-create supreme-code
  // entry (the project's fundamental law). ensureSupremeCode only creates when
  // missing — a re-init never clobbers existing code items.
  try {
    const { created } = await ensureSupremeCode(project.id, { createdVia: 'kb-init' });
    if (created) log.info(`KB ${project.id}: created empty supreme-code entry (hk2-supreme-code)`);
  } catch (err) {
    log.warn(`KB ${project.id}: failed to ensure supreme-code entry: ${err.message}`);
  }
  const meta = {
    name: project.id,
    projectName: project.name || project.id,
    sourcePath: absSource,
    sourceRoot,
    extraRoots: Array.isArray(project.extraRoots) ? project.extraRoots : [],
    includeGlobs: effectiveInclude,
    excludeGlobs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: KB_LAYOUT_VERSION,
    parserVersion: PARSER_VERSION,
  };
  await saveMeta(project.id, meta);
  return meta;
}

/**
 * Legacy addKb: build a KB by name (instead of project record). Used by the
 * `--mode=build-kb` escape hatch when no current project is set (KB name
 * falls back to 'default'). Writes meta.json only — no separate registry.
 *
 * Optional `opts.extra` accepts comma-separated "name:relRoot" entries to
 * register additional source roots under named prefixes.
 */
export async function addKb(name, sourcePath, opts = {}) {
  if (!name) throw new Error('KB name required');
  if (!await exists(sourcePath)) throw new Error(`source path not found: ${sourcePath}`);
  const absSource = path.resolve(sourcePath);
  const sourceRoot = opts.root || '';
  const rootAbs = sourceRoot ? path.join(absSource, sourceRoot) : absSource;
  if (!await exists(rootAbs)) throw new Error(`source root not found: ${rootAbs}`);

  const includeGlobs = opts.include ? String(opts.include).split(',') : DEFAULT_INCLUDE;
  const excludeGlobs = opts.exclude ? String(opts.exclude).split(',') : DEFAULT_EXCLUDE;

  const extraRoots = [];
  if (opts.extra) {
    for (const item of String(opts.extra).split(',')) {
      const colon = item.indexOf(':');
      if (colon > 0) {
        const rname = item.slice(0, colon);
        const relRoot = item.slice(colon + 1);
        const fullRoot = path.join(absSource, relRoot);
        if (await exists(fullRoot)) {
          extraRoots.push({ name: rname, relRoot });
        }
      }
    }
  }

  await createKbDir(name);
  const meta = {
    name,
    sourcePath: absSource,
    sourceRoot,
    extraRoots,
    includeGlobs,
    excludeGlobs,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: KB_LAYOUT_VERSION,
    parserVersion: PARSER_VERSION,
  };
  await saveMeta(name, meta);
  return meta;
}

/**
 * Resolve a stored path (possibly carrying an extra-root prefix) to absolute.
 */
export async function resolveStoredPath(meta, storedPath) {
  for (const r of (meta.extraRoots || [])) {
    const prefix = r.name + '/';
    if (storedPath.startsWith(prefix)) {
      return path.join(meta.sourcePath, r.relRoot, storedPath.slice(prefix.length));
    }
  }
  return path.join(meta.sourcePath, meta.sourceRoot || '', storedPath);
}

export async function dropKb(name) {
  await deleteKb(name);
}

export async function getKbMeta(name) {
  return getMeta(name);
}

export async function listKbs() {
  const { listKbs: ls } = await import('../store/kb_store.js');
  return ls();
}

export async function getStats(name) {
  const meta = await getMeta(name);
  if (!meta) return null;
  const stats = await readStats(name);
  return { meta, stats };
}

export async function resolveSourceFile(name, relPath) {
  const meta = await getMeta(name);
  if (!meta) throw new Error(`KB ${name} not found`);
  return path.join(meta.sourcePath, meta.sourceRoot || '', relPath);
}
