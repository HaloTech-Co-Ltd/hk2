/**
 * Generic multi-language symbol extractor.
 *
 * For files the dedicated C/Y/L parsers don't handle, this module detects
 * language by extension and extracts function / class / method definitions
 * using language-specific regexes. Output uses the same Symbol shape as
 * parseCSource so the indexer / BM25 / callgraph pipeline is unchanged.
 *
 * Supported languages (best-effort, regex-based):
 *   Python, JavaScript, TypeScript, JSX/TSX, Go, Rust, Java, Kotlin, Scala,
 *   Ruby, PHP, Swift, Shell/Bash/Zsh.
 *
 * Symbol kinds emitted: function, class, method, type, macro_const (for
 * top-level const/let bindings treated as constants).
 *
 * Precision is best-effort — the goal is to give BM25 useful anchors, not
 * to be a real AST. Strings/comments are stripped with a simple state
 * machine first to avoid matching keywords inside them.
 */

const LANG_BY_EXT = {
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  sh: 'shell', bash: 'shell', zsh: 'shell',
};

/**
 * Strip line comments (// ... and # ...), block comments (slash-star ... star-slash),
 * and string literals. Preserves newlines so line numbers stay accurate.
 */
function stripCommentsStrings(src, opts = {}) {
  const lineComment = opts.lineComment || null;
  const blockCommentStart = opts.blockCommentStart || null;
  const blockCommentEnd = opts.blockCommentEnd || null;
  const stringChars = opts.stringChars || ['"', "'"];
  const tripleStrings = opts.tripleStrings || [];
  let out = '';
  let i = 0;
  let lineCol = 0;
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    // Triple-quoted strings (Python)
    if (tripleStrings.length > 0) {
      let matched = null;
      for (const ts of tripleStrings) {
        if (src.startsWith(ts, i)) { matched = ts; break; }
      }
      if (matched) {
        const close = src.indexOf(matched, i + matched.length);
        const end = close === -1 ? src.length : close + matched.length;
        for (let j = i; j < end; j++) {
          out += src[j] === '\n' ? '\n' : ' ';
        }
        i = end;
        continue;
      }
    }

    // Line comment
    if (lineComment && src.startsWith(lineComment, i)) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      for (let j = i; j < end; j++) out += ' ';
      if (nl !== -1) { out += '\n'; i = nl + 1; continue; }
      i = end;
      continue;
    }

    // Block comment
    if (blockCommentStart && src.startsWith(blockCommentStart, i)) {
      const close = src.indexOf(blockCommentEnd, i + blockCommentStart.length);
      const end = close === -1 ? src.length : close + blockCommentEnd.length;
      for (let j = i; j < end; j++) {
        out += src[j] === '\n' ? '\n' : ' ';
      }
      i = end;
      continue;
    }

    // String literal
    if (stringChars.includes(c)) {
      // f-string / r-string prefix already handled by stripping prefix chars before reaching here
      out += ' ';
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { out += '  '; j += 2; continue; }
        if (src[j] === c) { out += ' '; j++; break; }
        if (src[j] === '\n') { out += '\n'; }
        else out += ' ';
        j++;
      }
      i = j;
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

const STRATEGIES = {
  python: {
    lineComment: '#',
    tripleStrings: ['"""', "'''"],
    stringChars: ['"', "'"],
  },
  javascript: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'", '`'],
  },
  typescript: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'", '`'],
  },
  go: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'", '`'],
  },
  rust: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'"],
  },
  java: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'"],
  },
  kotlin: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'", '"""'],
  },
  scala: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'"],
  },
  ruby: {
    lineComment: '#',
    blockCommentStart: '=begin',
    blockCommentEnd: '=end',
    stringChars: ['"', "'", '`'],
  },
  php: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'"],
  },
  swift: {
    lineComment: '//',
    blockCommentStart: '/*',
    blockCommentEnd: '*/',
    stringChars: ['"', "'"],
  },
  shell: {
    lineComment: '#',
    stringChars: ['"', "'", '`'],
  },
};

/**
 * Patterns per language. Each entry: { kind, re, nameGroup, sigGroup? }.
 * `re` must have `name` group; `sigGroup` defaults to the full match.
 *
 * Patterns are applied line-by-line to the stripped source (no lookbehind
 * tricks). Multi-line function signatures are partially supported via the
 * `pendingSig` mechanism: when a line opens a paren that doesn't close,
 * we keep consuming until balance.
 */
const PATTERNS = {
  python: [
    { kind: 'class', re: /^(\s*)(class)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(async\s+def|def)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
  ],
  javascript: [
    { kind: 'class', re: /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(export\s+)?(const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?\([^)]*\)\s*=>/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/, nameGroup: 'name', methodLike: true },
  ],
  typescript: [
    { kind: 'class', re: /^(\s*)(export\s+)?(default\s+)?(abstract\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'interface', re: /^(\s*)(export\s+)?interface\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name', kindLabel: 'type' },
    { kind: 'type', re: /^(\s*)(export\s+)?type\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(export\s+)?(const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(async\s*)?\([^)]*\)\s*=>/, nameGroup: 'name' },
  ],
  go: [
    { kind: 'type', re: /^(\s*)type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+struct/, nameGroup: 'name' },
    { kind: 'type', re: /^(\s*)type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+interface/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)func\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 'name' },
    { kind: 'method', re: /^(\s*)func\s*\([^)]*\)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/, nameGroup: 'name' },
  ],
  rust: [
    { kind: 'type', re: /^(\s*)(pub\s+)?struct\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'type', re: /^(\s*)(pub\s+)?enum\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'type', re: /^(\s*)(pub\s+)?trait\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(pub\s+)?(async\s+)?(unsafe\s+)?fn\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/, nameGroup: 'name' },
  ],
  java: [
    { kind: 'class', re: /^(\s*)(public\s+|private\s+|protected\s+)?(abstract\s+|final\s+|static\s+)*class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'class', re: /^(\s*)(public\s+|private\s+|protected\s+)?(abstract\s+|final\s+|static\s+)*interface\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'method', re: /^(\s*)(public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*(?:[\w<>\[\],?\s]+)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:throws[\s\w.,]+)?\{/, nameGroup: 'name' },
  ],
  kotlin: [
    { kind: 'class', re: /^(\s*)(?:public\s+|private\s+|internal\s+|protected\s+)?(?:data\s+|sealed\s+|abstract\s+|open\s+)*class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(?:public\s+|private\s+|internal\s+|protected\s+)?(?:suspend\s+)?fun\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
  ],
  scala: [
    { kind: 'class', re: /^(\s*)(?:override\s+)?(?:sealed\s+|abstract\s+|final\s+)*class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)def\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
  ],
  ruby: [
    { kind: 'class', re: /^(\s*)class\s+(?<name>[A-Z][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'class', re: /^(\s*)module\s+(?<name>[A-Z][A-Za-z0-9_]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)def\s+(?<name>[A-Za-z_][!?]?[A-Za-z0-9_!?]*)/, nameGroup: 'name' },
  ],
  php: [
    { kind: 'class', re: /^(\s*)(?:final\s+|abstract\s+|public\s+)*class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(?:public\s+|private\s+|protected\s+|static\s+)*function\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
  ],
  swift: [
    { kind: 'class', re: /^(\s*)(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?(?:final\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'type', re: /^(\s*)(?:public\s+|private\s+|internal\s+)?(?:final\s+)?struct\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'type', re: /^(\s*)(?:public\s+|private\s+|internal\s+)?enum\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(?:public\s+|private\s+|internal\s+)?func\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/, nameGroup: 'name' },
  ],
  shell: [
    { kind: 'function', re: /^(\s*)function\s+(?<name>[A-Za-z_][A-Za-z0-9_-]*)\s*\(\)/, nameGroup: 'name' },
    { kind: 'function', re: /^(\s*)(?<name>[A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/, nameGroup: 'name' },
  ],
};

/**
 * Patterns are already JS regex literals with named groups; compilePattern
 * is now a no-op that just returns the regex as-is.
 */
function compilePattern(re) {
  return { re, groupNames: [{ name: 'name', idx: null }] };
}

const COMPILED = {};
for (const [lang, patterns] of Object.entries(PATTERNS)) {
  COMPILED[lang] = patterns.map(p => ({ ...p, _re: p.re }));
}

/**
 * Detect language from file path.
 */
export function detectLanguage(filePath) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filePath || '');
  if (!m) return null;
  return LANG_BY_EXT[m[1].toLowerCase()] || null;
}

/**
 * Parse a source file. Returns array of symbols.
 */
export function parseGenericSource(srcText, opts = {}) {
  const fileId = opts.fileId ?? 0;
  const filePath = opts.filename || '';
  const lang = opts.language || detectLanguage(filePath);
  if (!lang || !STRATEGIES[lang] || !COMPILED[lang]) return [];
  const strat = STRATEGIES[lang];
  const patterns = COMPILED[lang];

  const stripped = stripCommentsStrings(srcText, strat);
  const lines = stripped.split('\n');
  const srcLines = srcText.split('\n');

  const symbols = [];
  let pendingSig = null;
  let pendingStart = -1;
  let pendingName = null;
  let pendingKind = null;

  const emit = (startLine, endLine, name, kind, signature) => {
    const id = `${fileId}:${startLine}`;
    const body = srcLines.slice(startLine - 1, endLine).join('\n');
    symbols.push({
      id,
      name,
      kind,
      fileId,
      lineStart: startLine,
      lineEnd: endLine,
      signature: (signature || srcLines[startLine - 1] || '').trim(),
      body,
      modifiers: [],
      paramNames: [],
      references: [],
    });
  };

  const tryEmitBlock = (lineIdx, line, name, kind, signature, braceChar) => {
    // Find matching closing brace starting from this line
    let depth = 0;
    let seenOpen = false;
    let endLine = lineIdx;
    for (let j = lineIdx; j < srcLines.length; j++) {
      const l = srcLines[j];
      for (const ch of l) {
        if (ch === braceChar && !seenOpen) {
          seenOpen = true;
          depth = 1;
        } else if (ch === braceChar) {
          depth++;
        } else if (ch === (braceChar === '{' ? '}' : braceChar === '[' ? ']' : ')') && seenOpen) {
          depth--;
          if (depth === 0) {
            endLine = j + 1;
            emit(lineIdx + 1, endLine, name, kind, signature);
            return true;
          }
        }
      }
      // For python: indentation-based blocks; close on dedent
      if (kind !== 'class' && (lang === 'python')) {
        // crude: assume block continues until a line with less indentation than the def/class line
      }
      if (seenOpen && depth === 0) { endLine = j + 1; break; }
    }
    if (seenOpen) {
      emit(lineIdx + 1, srcLines.length, name, kind, signature);
      return true;
    }
    return false;
  };

  const tryEmitIndentBlock = (lineIdx, line, name, kind, signature) => {
    // Python-style: block is the def/class line + all following lines with deeper indent
    const baseIndent = line.match(/^\s*/)[0].length;
    let endLine = lineIdx + 1;
    for (let j = lineIdx + 1; j < srcLines.length; j++) {
      const l = srcLines[j];
      if (l.trim() === '') continue;
      const indent = l.match(/^\s*/)[0].length;
      if (indent <= baseIndent) break;
      endLine = j + 1;
    }
    emit(lineIdx + 1, endLine, name, kind, signature);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Continue pending signature across lines
    if (pendingSig) {
      pendingSig += ' ' + line.trim();
      const openCount = (pendingSig.match(/\(/g) || []).length;
      const closeCount = (pendingSig.match(/\)/g) || []).length;
      if (openCount > 0 && openCount === closeCount) {
        // Signature complete; emit block from pendingStart
        const isIndent = lang === 'python';
        if (isIndent) {
          tryEmitIndentBlock(pendingStart, srcLines[pendingStart], pendingName, pendingKind, pendingSig.trim());
        } else {
          // Look for { on this line or later
          const braceIdx = pendingSig.indexOf('{');
          if (braceIdx >= 0) {
            tryEmitBlock(pendingStart, srcLines[pendingStart], pendingName, pendingKind, pendingSig.trim(), '{');
          }
        }
        pendingSig = null;
        pendingStart = -1;
        pendingName = null;
        pendingKind = null;
        continue;
      }
      continue;
    }

    let matched = false;
    for (const p of patterns) {
      const m = p._re.exec(line);
      if (!m) continue;
      const name = m.groups?.name || null;
      if (!name) continue;
      const kind = p.kindLabel || p.kind;
      const signature = srcLines[i].trim();

      if (lang === 'python') {
        tryEmitIndentBlock(i, srcLines[i], name, kind, signature);
        matched = true;
        break;
      }

      // Brace-based languages: maybe signature spans multiple lines
      const openCount = (signature.match(/\(/g) || []).length;
      const closeCount = (signature.match(/\)/g) || []).length;
      const hasBrace = signature.includes('{');
      if (openCount > closeCount && !hasBrace) {
        pendingSig = signature;
        pendingStart = i;
        pendingName = name;
        pendingKind = kind;
        matched = true;
        break;
      }
      if (hasBrace) {
        tryEmitBlock(i, srcLines[i], name, kind, signature, '{');
      } else if (kind === 'type' || kind === 'class') {
        // Type declaration without immediate brace — best effort: emit single line
        emit(i + 1, i + 1, name, kind, signature);
      } else {
        // Forward declaration / prototype
        emit(i + 1, i + 1, name, kind, signature);
      }
      matched = true;
      break;
    }
  }

  return symbols;
}

export default parseGenericSource;
