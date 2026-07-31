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
 * callgraphbuild。
 *
 * 输入：all symbols（每个含 references: string[] identifierlist）
 * 输出：{ byId: { <symbolId>: [<referencedSymbolId>, ...] },
 *          nameIndex: { <name>: [<symbolId>, ...] } }
 *
 * edge规则：若 symbol S 的 references 含 name N，且 N 是某个全局symbol的名字，
 *   则加edge S → 选择一个候选（同file > 同directory > 第一个）。
 */

export function buildCallGraph(symbols, options = {}) {
  const byId = {};
  /** name → [{symbolId, fileId, dirPath}] */
  const nameIndex = new Map();

  // build名字index
  for (const s of symbols) {
    if (!s.name) continue;
    const entry = {
      symbolId: s.id,
      fileId: s.fileId,
    };
    if (!nameIndex.has(s.name)) nameIndex.set(s.name, []);
    nameIndex.get(s.name).push(entry);
  }

  // filepath映射（用于歧义消解）— 这里我们只有 fileId，没有path，
  // call方应在 opts.fileDirById 提供该映射
  const fileDirById = options.fileDirById || {};

  for (const s of symbols) {
    if (!s.references || s.references.length === 0) continue;
    const edgesSet = new Set();
    for (const refName of s.references) {
      if (refName === s.name) continue;       // 不自reference
      const candidates = nameIndex.get(refName);
      if (!candidates || candidates.length === 0) continue;
      const target = pickBest(candidates, s, fileDirById);
      if (target) edgesSet.add(target);
    }
    if (edgesSet.size > 0) byId[s.id] = Array.from(edgesSet);
  }

  return {
    byId,
    nameIndex: Object.fromEntries(Array.from(nameIndex.entries()).map(([k, v]) => [k, v.map(e => e.symbolId)])),
  };
}

function pickBest(candidates, source, fileDirById) {
  if (candidates.length === 1) return candidates[0].symbolId;
  // 同file优先
  const sameFile = candidates.filter(c => c.fileId === source.fileId);
  if (sameFile.length > 0) return sameFile[0].symbolId;
  // 同directory优先
  const srcDir = fileDirById[source.fileId];
  if (srcDir) {
    const sameDir = candidates.filter(c => fileDirById[c.fileId] === srcDir);
    if (sameDir.length > 0) return sameDir[0].symbolId;
  }
  // 第一个
  return candidates[0].symbolId;
}

export default buildCallGraph;
