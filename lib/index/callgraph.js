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
