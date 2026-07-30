/**
 * Context builder: combine topic intro + symbols into an LLM prompt,
 * bounded by a character budget.
 *
 * Output: { system, user }
 */

import { tokenizeText } from '../index/text_tokenizer.js';

/**
 * @param {object} params
 * @param {{topic?: string, title?: string, intro?: string}} [params.topic]
 * @param {Array} params.symbols  Symbols to include
 * @param {string} params.query
 * @param {number} [params.maxChars]
 * @param {string} [params.mode]  'principle' | 'suggest'
 * @param {Array} [params.templateSymbols]
 * @param {string} [params.filePathResolver]  optional
 */
export function buildContext(params) {
  const { topic, symbols = [], templateSymbols = [], query, maxChars = 65536, mode = 'principle', filePathResolver } = params;
  const parts = [];
  let used = 0;

  // 1. topic intro
  if (topic && topic.intro) {
    const header = `## Topic: ${topic.title || topic.topic}\n\n${topic.intro}\n`;
    parts.push({ role: 'header', text: header });
    used += header.length;
  }

  // 2. template symbols (suggest mode)
  if (templateSymbols && templateSymbols.length > 0) {
    const header = `\n## Reference templates (existing project implementations)\n`;
    parts.push({ role: 'header', text: header });
    used += header.length;
    for (const sym of templateSymbols) {
      const text = formatSymbol(sym, filePathResolver, true);
      if (used + text.length > maxChars * 0.3) break;
      parts.push({ role: 'symbol', text });
      used += text.length;
    }
  }

  // 3. BM25-ranked symbols (remaining budget)
  const sortedSyms = [...symbols];
  parts.push({ role: 'header', text: `\n## Related symbols (ranked by relevance)\n` });
  for (const sym of sortedSyms) {
    const text = formatSymbol(sym, filePathResolver, false);
    if (used + text.length > maxChars) {
      const remain = maxChars - used;
      if (remain > 200) {
        parts.push({ role: 'symbol', text: text.slice(0, remain) + '\n... (truncated)\n' });
        used = maxChars;
      }
      break;
    }
    parts.push({ role: 'symbol', text });
    used += text.length;
  }

  const user = parts.map(p => p.text).join('\n');
  const system = buildSystemPrompt(mode);
  return { system, user, usedChars: used };
}

function formatSymbol(sym, filePathResolver, isTemplate) {
  const path = filePathResolver ? filePathResolver(sym.fileId) : `fileId:${sym.fileId}`;
  const lines = [];
  const lang = inferLang(path);
  lines.push(`### ${sym.name} [${sym.kind}]  ${path}:${sym.lineStart}`);
  lines.push('```' + lang);
  // Template: full body (truncated to 1500 chars)
  // Non-template: signature + first 800 chars of body
  const limit = isTemplate ? 1500 : 800;
  let body = sym.body || sym.signature || '';
  if (body.length > limit) body = body.slice(0, limit) + '\n/* ... truncated ... */';
  lines.push(body);
  lines.push('```');
  return lines.join('\n');
}

function inferLang(filePath) {
  if (!filePath) return '';
  const m = /\.([A-Za-z0-9]+)$/i.exec(filePath);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  if (['c', 'h'].includes(ext)) return 'c';
  if (['cpp', 'cc', 'hpp', 'cxx'].includes(ext)) return 'cpp';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (['jsx'].includes(ext)) return 'jsx';
  if (['ts'].includes(ext)) return 'typescript';
  if (['tsx'].includes(ext)) return 'tsx';
  if (ext === 'py') return 'python';
  if (ext === 'go') return 'go';
  if (ext === 'rs') return 'rust';
  if (ext === 'java') return 'java';
  if (ext === 'kt') return 'kotlin';
  if (ext === 'scala') return 'scala';
  if (ext === 'rb') return 'ruby';
  if (ext === 'php') return 'php';
  if (ext === 'swift') return 'swift';
  if (['sh', 'bash', 'zsh'].includes(ext)) return 'bash';
  return '';
}

function buildSystemPrompt(mode) {
  if (mode === 'principle') {
    return `You are a senior software engineer helping a colleague understand how a part of the project works. Using the provided code symbols (with file paths and line numbers), give a focused, accurate explanation of the user's question.

Style:
- Talk like a senior engineer at a whiteboard: direct, technical, no filler.
- Anchor every claim to a concrete identifier / field / call site, cited as [relative/path.ext:line]. Write "X calls Y at [src/foo.c:1234]", not "this step writes".
- Use prose for the narrative; reserve lists for genuine enumerations or sequences. Don't bullet-point what should be a paragraph.
- If the provided context is insufficient, say so explicitly: "I need to look at X's implementation". Don't invent.
- Be concise. Don't restate the question before answering. No closing summary block.`;
  }
  if (mode === 'suggest') {
    return `You are a senior software engineer doing a design review. Given the provided "template symbols" (existing similar implementations in the project) and "related symbols", propose a concrete, actionable implementation plan.

Style:
- Open with one or two paragraphs giving the core approach and why; then expand on key steps. Number steps in order, bullet when parallel, prose otherwise — don't force structure.
- Code skeletons should use existing project APIs. Cite each non-trivial call as [file:line].
- Don't copy template code verbatim; adapt to the requirement. If you reuse a chunk, say why.
- List only real gotchas: lock ordering, error-recovery paths, concurrency races. Skip platitudes like "consider performance".
- Be concrete about test strategy: name the framework and the file.
- Be concise. Don't restate the requirement. No closing summary block.`;
  }
  return 'You are a software engineering assistant. Answer the user question based on the provided code context.';
}

/**
 * Match the most relevant principles for the query.
 * @param {Array} principles  principle list
 * @param {string} query
 * @returns {Array} top 2 matched principles with score
 */
export function matchPrinciples(principles, query) {
  if (!principles || principles.length === 0) return [];
  const queryTokens = new Set(tokenizeText(query));
  if (queryTokens.size === 0) return [];
  const scored = [];
  for (const p of principles) {
    const topicTokens = new Set([
      ...tokenizeText(p.topic || ''),
      ...tokenizeText(p.title || ''),
      ...(p.keywords || []).flatMap(kw => tokenizeText(kw)),
    ]);
    let overlap = 0;
    for (const t of queryTokens) if (topicTokens.has(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / Math.sqrt(topicTokens.size);
    scored.push({ principle: p, score, overlap });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2);
}

export default buildContext;
