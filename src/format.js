/**
 * Plain-text output formatting for legacy --mode commands.
 *
 * - printCodeResults: --mode=code result list
 * - printTopics: [matched topics] header (verbose)
 * - printSymbols: [referenced symbols N] header (verbose)
 * - printCachedAnswer: output when a saved answer hits
 */

/**
 * @param {Array} results  codeSearch return value
 */
export function printCodeResults(results) {
  if (!results || results.length === 0) {
    console.log('(no results)');
    return;
  }
  for (const r of results) {
    console.log(`${r.name} [${r.kind}]  ${r.filePath}:${r.lineStart}  score=${r.score.toFixed(2)}`);
    if (r.signature) console.log(`  ${r.signature}`);
    if (r.snippet) {
      const snippet = String(r.snippet).split('\n').slice(0, 4).join('\n');
      process.stdout.write(indent(snippet, '  ') + '\n');
    }
    console.log();
  }
  console.log(`(${results.length} results)`);
}

/**
 * @param {Array} topics  [{topic, title}]
 */
export function printTopics(topics) {
  if (!topics || topics.length === 0) return;
  console.log('[matched topics]');
  for (const t of topics) {
    console.log(`- ${t.title} (${t.topic})`);
  }
  console.log();
}

/**
 * @param {Array} symbols  [{id, name, kind, filePath, lineStart, signature, isTemplate?}]
 */
export function printSymbols(symbols) {
  if (!symbols || symbols.length === 0) return;
  console.log(`[referenced symbols ${symbols.length}]`);
  for (const s of symbols.slice(0, 30)) {
    const tag = s.isTemplate ? '* ' : '';
    console.log(`- ${tag}${s.name}  ${s.filePath}:${s.lineStart}`);
  }
  if (symbols.length > 30) console.log(`... +${symbols.length - 30} more`);
  console.log();
  console.log('[answer]');
}

/**
 * Output when a saved answer hits.
 *
 * @param {object} cached  { id, query, answer, topics, symbols, rewrite, createdAt }
 */
export function printCachedAnswer(cached) {
  const created = cached.createdAt
    ? new Date(cached.createdAt).toLocaleString('en-US')
    : '';
  console.log(`[KB hit${created ? ` (saved ${created})` : ''}]`);
  console.log();
  if (cached.topics?.length > 0) printTopics(cached.topics);
  if (cached.symbols?.length > 0) {
    console.log(`[referenced symbols ${cached.symbols.length}]`);
    for (const s of cached.symbols.slice(0, 30)) {
      const tag = s.isTemplate ? '* ' : '';
      console.log(`- ${tag}${s.name}  ${s.filePath || ''}:${s.lineStart || ''}`);
    }
    if (cached.symbols.length > 30) console.log(`... +${cached.symbols.length - 30} more`);
    console.log();
  }
  console.log('[answer]');
  process.stdout.write((cached.answer || '') + '\n');
}

function indent(text, prefix) {
  return text.split('\n').map(l => prefix + l).join('\n');
}
