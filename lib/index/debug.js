/**
 * debug入口：parse单个file并打印symboldigest。
 */
import fs from 'node:fs/promises';
import { parseCSource } from '../parser/c_parser.js';

export async function parseFileForDebug(absPath) {
  const text = await fs.readFile(absPath, 'utf8');
  const t0 = Date.now();
  const { symbols } = parseCSource(text, { fileId: 1 });
  const dt = Date.now() - t0;
  const summary = {
    file: absPath,
    loc: text.split('\n').length,
    symbolCount: symbols.length,
    parseMs: dt,
    kindCounts: symbols.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
    symbols: symbols.map(s => ({
      kind: s.kind, name: s.name,
      lineRange: [s.lineStart, s.lineEnd],
      params: s.paramNames,
      modifiers: s.modifiers,
      refCount: (s.references || []).length,
    })),
  };
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: node debug.js <file>'); process.exit(1); }
  parseFileForDebug(file).then(s => console.log(JSON.stringify(s, null, 2)));
}
