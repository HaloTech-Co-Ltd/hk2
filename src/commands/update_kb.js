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
 * update-kb mode: incremental KB update.
 *
 * Reads meta.json to get KB info, calls buildIndex({full:false}) which uses
 * sha256-based file diffing (only changed files are re-parsed; inverted index
 * and callgraph are rebuilt every time since their cost is much lower than parsing).
 */
import { getMeta } from '../../lib/store/kb_store.js';
import { resolveKbName } from '../kb_name.js';

export async function updateKb() {
  const kbName = await resolveKbName();
  const meta = await getMeta(kbName);
  if (!meta) {
    console.error(`Error: no KB found for "${kbName}". Run --mode=build-kb first.`);
    process.exit(2);
  }

  const { buildIndex } = await import('../../lib/index/indexer.js');

  console.error(`[update-kb] kb: ${kbName}`);
  console.error(`[update-kb] source: ${meta.sourcePath}`);
  console.error(`[update-kb] sourceRoot: ${meta.sourceRoot || '(none)'}`);

  // Legacy-KB upgrade check: fix stale layout signals losslessly before the
  // incremental re-index (same flow as the interactive /kb update command).
  let full = false;
  try {
    const { migrateKb } = await import('../../lib/store/kb_migrate.js');
    const migration = await migrateKb(kbName);
    if (migration.error) {
      console.error(`[update-kb] upgrade aborted: ${migration.error}`);
      process.exit(2);
    }
    if (migration.needed) {
      console.error(`[update-kb] legacy KB detected — upgrading to the current layout:`);
      for (const it of migration.items) console.error(`  - ${it.id}: ${it.reason}`);
      for (const line of migration.performed || []) console.error(`  + ${line}`);
      if (migration.backupDir) console.error(`  + knowledge snapshot: ${migration.backupDir}`);
      full = !!migration.fullRebuild;
      if (full) console.error(`  + parser format changed — full re-index will follow`);
    }
  } catch (err) {
    console.error(`[update-kb] upgrade check failed (continuing with normal update): ${err.message}`);
  }

  const stats = await buildIndex(kbName, {
    full,
    onProgress: ({ done, total, file }) => {
      if (done % 25 === 0 || done === total) {
        console.error(`[${done}/${total}] ${file || ''}`);
      }
    },
  });

  console.error(`done: ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ${stats.uniqueTokens} tokens, ${(stats.buildDurationMs / 1000).toFixed(1)}s`);
}
