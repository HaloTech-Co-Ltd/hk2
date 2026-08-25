/**
 * Document cross-reference graph builder (pure functions).
 *
 * Consumes the deep-parse output of lib/parser/doc_parser.js (links / tables /
 * codeBlocks per document) plus the set of code symbol names collected by the
 * indexer, and produces a serializable doc index:
 *
 *   {
 *     docs:          { [docPath]: { linkCount, tableCount, codeBlockCount, referencedBy: [docPath] } },
 *     links:         [ { from, to, text, anchor } ],        // resolved doc→doc references
 *     referencedBy:  { [docPath]: [fromDocPath, ...] },      // reverse of links
 *     tables:        [ { doc, section, headers, align, rows } ],
 *     symbolMentions:{ [symbolName]: [ { doc, kind: 'code'|'prose', lang } ] },
 *     meta:          { docCount, linkCount, tableCount, symbolMentionCount, version }
 *   }
 *
 * Persisted by lib/store/doc_index_store.js as doc_index.json — deliberately
 * SEPARATE from the code knowledge graph (graph/) so code-graph traversal
 * tools (kb_callchain etc.) keep their pure-symbol semantics.
 */

import path from 'node:path';

export const DOC_INDEX_VERSION = 1;

const EXTERNAL_LINK_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;   // http:, mailto:, ...
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** True when a link target points outside the repo (scheme or protocol-relative). */
function isExternal(target) {
  return !target || EXTERNAL_LINK_RE.test(target) || target.startsWith('//');
}

/** Normalize a link target for doc-path matching: decode, strip anchor, unify slashes. */
function normalizeTarget(target) {
  let t = target.split('#')[0];
  if (!t) return '';
  try { t = decodeURI(t); } catch { /* keep raw on malformed URI */ }
  t = t.replace(/\\/g, '/');
  while (t.startsWith('./')) t = t.slice(2);
  return t;
}

/** POSIX-style dirname of a repo-relative doc path ('' for root-level files). */
function dirOfPath(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * Resolve one link target against the set of known doc paths, interpreting
 * the target RELATIVE TO THE SOURCE DOCUMENT's directory (the same way a
 * Markdown renderer would). Tries: relative-resolved, absolute-as-given,
 * +'.md'/'+'.markdown', dir+'README.md' (for `.../` links), then a
 * case-insensitive fallback. Returns the matched doc path or null.
 */
function resolveDocTarget(target, fromDoc, docPathsSet, docPathsLower) {
  const norm = normalizeTarget(target);
  if (!norm || norm.startsWith('/')) {
    // Absolute targets match only when literally present in the doc set.
    if (!norm) return null;
    const abs = norm.slice(1);
    return docPathsSet.has(abs) ? abs : (docPathsLower.get(abs.toLowerCase()) || null);
  }
  const fromDir = dirOfPath(fromDoc);
  const joined = fromDir ? path.posix.normalize(`${fromDir}/${norm}`) : norm;
  const candidates = [joined, norm];
  for (const base of candidates) {
    if (!/\.[a-z0-9]+$/i.test(base)) {
      candidates.push(`${base}.md`, `${base}.markdown`);
      candidates.push(base.endsWith('/') ? `${base}README.md` : `${base}/README.md`);
    }
  }
  for (const c of candidates) {
    if (docPathsSet.has(c)) return c;
  }
  const lower = candidates[0].toLowerCase();
  const ci = docPathsLower.get(lower);
  if (ci) return ci;
  // Case-insensitive on the as-given form too
  for (const c of candidates) {
    const hit = docPathsLower.get(c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Strip fenced code blocks from raw markdown (for prose-only symbol scans). */
function stripFences(src) {
  return String(src || '').replace(/(^|\n)([ \t]*)(```|~~~)[\s\S]*?\2?\3[ \t]*(?=\n|$)/g, '$1');
}

/** Tokenize an identifier-bearing string into a Set of identifiers. */
function identSet(s) {
  const out = new Set();
  let m;
  IDENT_RE.lastIndex = 0;
  while ((m = IDENT_RE.exec(s)) !== null) out.add(m[0]);
  return out;
}

/**
 * Pre-extract the prose identifier set from a document's full raw text.
 * Persisted alongside (in place of relying on) the raw text in _docInputs:
 * the indexer caps stored text at 20k chars, which would silently drop prose
 * symbol mentions near the tail of large documents on incremental merges.
 * A precomputed identifier set is bounded by the doc's actual vocabulary and
 * survives the round-trip regardless of text truncation.
 */
export function proseIdentifiers(text) {
  return Array.from(identSet(stripFences(String(text || '')))).slice(0, 2000);
}

/**
 * Build the doc cross-reference index.
 *
 * @param {object} input
 * @param {Array<{path: string, links?: Array, tables?: Array, codeBlocks?: Array, text?: string}>} input.docs
 *   Deep-parse results, one per indexed document. `text` is the raw source
 *   (used for prose symbol mentions).
 * @param {Iterable<string>|Set<string>} input.symbolNames
 *   Defined code symbol names (from the symbol shards) used to associate docs
 *   with real code symbols.
 * @returns {object} serializable doc index (see module doc)
 */
export function buildDocGraph(input) {
  const docs = Array.isArray(input?.docs) ? input.docs.filter(d => d && d.path) : [];
  const symbolNames =
    input?.symbolNames instanceof Set ? input.symbolNames : new Set(input?.symbolNames || []);

  const docPathsSet = new Set(docs.map(d => d.path));
  const docPathsLower = new Map();
  for (const d of docs) {
    const lower = d.path.toLowerCase();
    if (!docPathsLower.has(lower)) docPathsLower.set(lower, d.path);
  }

  const links = [];
  const referencedBy = {};
  const docRecords = {};
  const tables = [];
  const symbolMentions = {};
  const MAX_MENTIONS_PER_SYMBOL = 50;

  const addMention = (symbol, doc, kind, lang) => {
    if (!symbolMentions[symbol]) symbolMentions[symbol] = [];
    const lst = symbolMentions[symbol];
    if (lst.length >= MAX_MENTIONS_PER_SYMBOL) return;
    if (lst.some(m => m.doc === doc && m.kind === kind)) return;  // dedupe per doc+kind
    lst.push({ doc, kind, ...(lang ? { lang } : {}) });
  };

  for (const d of docs) {
    const docLinks = Array.isArray(d.links) ? d.links : [];
    const docTables = Array.isArray(d.tables) ? d.tables : [];
    const docCode = Array.isArray(d.codeBlocks) ? d.codeBlocks : [];

    // 1) Cross references: doc → doc
    const seenTargets = new Set();
    for (const link of docLinks) {
      const target = link && link.target;
      if (isExternal(target)) continue;
      const resolved = resolveDocTarget(target, d.path, docPathsSet, docPathsLower);
      if (!resolved || resolved === d.path) continue;
      const key = `${resolved}#${link.anchor || ''}`;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      links.push({
        from: d.path,
        to: resolved,
        text: String(link.text || '').slice(0, 120),
        anchor: String(link.anchor || ''),
      });
      if (!referencedBy[resolved]) referencedBy[resolved] = [];
      if (!referencedBy[resolved].includes(d.path)) referencedBy[resolved].push(d.path);
    }

    // 2) Tables: structured index entries
    for (const t of docTables) {
      if (!Array.isArray(t.headers) || t.headers.length === 0) continue;
      tables.push({
        doc: d.path,
        section: String(t.title || '').slice(0, 200),
        headers: t.headers.map(h => String(h || '').slice(0, 200)),
        align: Array.isArray(t.align) ? t.align : [],
        rows: (Array.isArray(t.rows) ? t.rows : []).map(r =>
          (Array.isArray(r) ? r : [r]).map(c => String(c ?? '').slice(0, 300))
        ),
      });
    }

    // 3) Symbol associations
    //    a) from fenced code examples: identifiers that match defined symbols
    for (const cb of docCode) {
      const code = cb && cb.code;
      if (!code) continue;
      for (const ident of identSet(code)) {
        if (symbolNames.has(ident)) addMention(ident, d.path, 'code', cb.lang || '');
      }
    }
    //    b) from prose: identifiers appearing in non-code text. A persisted
    //    proseIdents array (precomputed from the FULL text at parse time)
    //    takes precedence — the stored raw text may be truncated (>20k).
    const proseIdents = Array.isArray(d.proseIdents)
      ? new Set(d.proseIdents)
      : identSet(stripFences(d.text || ''));
    for (const ident of proseIdents) {
      if (symbolNames.has(ident)) addMention(ident, d.path, 'prose');
    }

    docRecords[d.path] = {
      linkCount: seenTargets.size,
      tableCount: docTables.length,
      codeBlockCount: docCode.length,
      referencedBy: [],   // backfilled AFTER the loop (order-independent)
    };
  }

  // Backfill the denormalized referencedBy copies once ALL links are known.
  // The per-record capture above is order-dependent: a doc processed BEFORE
  // its referrer would otherwise keep a stale empty array.
  for (const p of Object.keys(docRecords)) {
    docRecords[p].referencedBy = referencedBy[p] || [];
  }

  return {
    docs: docRecords,
    links,
    referencedBy,
    tables,
    symbolMentions,
    meta: {
      docCount: docs.length,
      linkCount: links.length,
      tableCount: tables.length,
      symbolMentionCount: Object.keys(symbolMentions).length,
      version: DOC_INDEX_VERSION,
    },
  };
}
