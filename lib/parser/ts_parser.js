/**
 * Tree-sitter multi-language AST parser.
 *
 * For each supported language, walks the AST and emits Symbol[] in the same
 * shape as the existing regex parsers (lib/parser/c_parser.js etc.), with
 * additional fields:
 *   - qualName       — dotted qualified name (Namespace.Class.method)
 *   - parentSymbolId — containing class/namespace symbol id
 *   - superClass     — base class names (resolved by builder)
 *   - implements     — interface names (resolved by builder)
 *   - imports        — module names imported (file-level aggregation)
 *   - docString      — preceding comment block
 *
 * Graceful degradation: if `tree-sitter` or a specific grammar fails to load,
 * the function returns null and the caller (ast.js) falls back to the regex
 * parsers.
 *
 * Symbol kind emitted: function, method, class, interface, struct, field,
 *                      type, import, const.
 */

let _parser = null;
let _ready = null;
const _modCache = new Map();   // pkgName → loaded module
const _wrapperCache = new Map(); // `${pkgName}::${ext}` → language wrapper

/**
 * Probe whether tree-sitter native bindings are installed. Memoised.
 * @returns {Promise<boolean>}
 */
export async function isTreeSitterReady() {
  if (_ready !== null) return _ready;
  try {
    const mod = await import('tree-sitter');
    _parser = mod.default || mod.Parser || mod;
    _ready = true;
  } catch (err) {
    _ready = false;
  }
  return _ready;
}

/**
 * Map of file extension → tree-sitter language package name.
 */
export const LANG_BY_EXT = {
  c: 'tree-sitter-c',
  h: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  cc: 'tree-sitter-cpp',
  cxx: 'tree-sitter-cpp',
  hpp: 'tree-sitter-cpp',
  cs: 'tree-sitter-c-sharp',
  py: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rs: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  kt: 'tree-sitter-kotlin',
  kts: 'tree-sitter-kotlin',
  scala: 'tree-sitter-scala',
  js: 'tree-sitter-javascript',
  mjs: 'tree-sitter-javascript',
  cjs: 'tree-sitter-javascript',
  jsx: 'tree-sitter-javascript',
  ts: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript',
  rb: 'tree-sitter-ruby',
  php: 'tree-sitter-php',
  sh: 'tree-sitter-bash',
  bash: 'tree-sitter-bash',
  zsh: 'tree-sitter-bash',
};

/**
 * Load a grammar module and return the wrapper object to pass to
 * `parser.setLanguage()`. Modern tree-sitter grammars export
 * `{ name, language, nodeTypeInfo }`; the binding's
 * `initializeLanguageNodeClasses` reads `nodeTypeInfo` from the object we
 * pass and tries to attach `nodeSubclasses` to it. If we instead pass the
 * bare `.language` (an N-API External with null prototype), property writes
 * are silently dropped, `nodeSubclasses` stays undefined, and any later
 * `tree.rootNode` access throws "Cannot read properties of undefined
 * (reading 'NNN')". So we must keep the wrapper.
 *
 * Multi-dialect packages (tree-sitter-typescript, tree-sitter-php) export
 * `{ <dialect>: <wrapper>, ... }`; pick by extension.
 */
async function loadLanguage(pkgName, ext) {
  const cacheKey = `${pkgName}::${ext}`;
  if (_wrapperCache.has(cacheKey)) return _wrapperCache.get(cacheKey);
  try {
    let mod = _modCache.get(pkgName);
    if (!mod) {
      mod = await import(pkgName);
      // Dynamic import of a CJS module gives { default, 'module.exports' }.
      // Unwrap to the real exports object so dialect lookups below work.
      if (mod && typeof mod === 'object' && mod.default && !mod.language && !mod.nodeTypeCount) {
        mod = mod.default || mod['module.exports'] || mod;
      }
      _modCache.set(pkgName, mod);
    }
    let wrapper;
    if (pkgName === 'tree-sitter-typescript') {
      wrapper = ext === 'tsx' ? (mod.tsx || mod.typescript) : (mod.typescript || mod.tsx);
    } else if (pkgName === 'tree-sitter-php') {
      wrapper = mod.php || mod.php_only;
    } else {
      wrapper = mod.language ? mod : (mod.default || mod);
    }
    if (!wrapper || (!wrapper.language && !wrapper.nodeTypeCount)) {
      _wrapperCache.set(cacheKey, null);
      return null;
    }
    _wrapperCache.set(cacheKey, wrapper);
    return wrapper;
  } catch (err) {
    _wrapperCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Structural-text pattern match — a regex-based approximation of ast-grep.
 *
 * v1 translates the pattern's metavariables into regex capture groups and
 * runs the result over the source. It does NOT respect AST boundaries, but
 * covers the common cases (named function calls, simple structural patterns)
 * and falls back gracefully when a grammar isn't available.
 *
 * Pattern syntax:
 *   $$$IDENT   — multi-wildcard capture (any text, non-greedy, multi-line)
 *   $IDENT     — single identifier capture ([A-Za-z_][A-Za-z0-9_]*)
 *   $_         — anonymous single-token wildcard (no capture)
 *   other      — literal text, regex-escaped
 *
 * `$$$` alone (no ident) is treated as an anonymous multi-wildcard.
 *
 * Returns an array of matches: { startLine, endLine, startCol, endCol, text,
 * meta } where `meta` is { IDENT: capturedText }. Returns null on unsupported
 * input (empty pattern, regex compile failure).
 */
export function queryPattern(src, pattern) {
  if (!src || !pattern || typeof src !== 'string' || typeof pattern !== 'string') return null;
  // Tokenize the pattern: split into literal spans and metavariable spans.
  const tokens = [];
  let buf = '';
  let i = 0;
  const flushBuf = () => { if (buf) { tokens.push({ kind: 'lit', text: buf }); buf = ''; } };
  while (i < pattern.length) {
    if (pattern[i] === '$') {
      // Possible metavariable
      if (pattern[i + 1] === '$' && pattern[i + 2] === '$') {
        // $$$IDENT or $$$ (anon multi)
        let j = i + 3;
        let name = '';
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j])) { name += pattern[j]; j++; }
        flushBuf();
        tokens.push({ kind: 'multi', name });
        i = j;
        continue;
      }
      if (pattern[i + 1] === '_') {
        // $_ — anon single
        flushBuf();
        tokens.push({ kind: 'anon' });
        i += 2;
        continue;
      }
      if (pattern[i + 1] && /[A-Za-z_]/.test(pattern[i + 1])) {
        // $IDENT — single identifier capture
        let j = i + 1;
        let name = '';
        while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j])) { name += pattern[j]; j++; }
        flushBuf();
        tokens.push({ kind: 'single', name });
        i = j;
        continue;
      }
      // Lone $ — literal
      buf += '$';
      i++;
      continue;
    }
    buf += pattern[i];
    i++;
  }
  flushBuf();

  // Build the regex. Capture group names must be valid JS regex identifiers
  // (start with a letter/underscore, no `$`). We use `m<idx>` for named
  // captures and stash a parallel map back to the user-facing name.
  let reSrc = '';
  const captureNames = [];   // index → user name
  let captureIdx = 0;
  for (const tok of tokens) {
    if (tok.kind === 'lit') {
      reSrc += tok.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (tok.kind === 'multi') {
      captureIdx++;
      const groupName = tok.name ? `m${captureIdx}` : null;
      if (groupName) {
        reSrc += `(?<${groupName}>[\\s\\S]*?)`;
        captureNames.push([groupName, tok.name]);
      } else {
        reSrc += `[\\s\\S]*?`;
      }
    } else if (tok.kind === 'single') {
      captureIdx++;
      const groupName = tok.name ? `m${captureIdx}` : null;
      if (groupName) {
        reSrc += `(?<${groupName}>[A-Za-z_][A-Za-z0-9_]*)`;
        captureNames.push([groupName, tok.name]);
      } else {
        reSrc += `[A-Za-z_][A-Za-z0-9_]*`;
      }
    } else if (tok.kind === 'anon') {
      reSrc += `\\S+`;
    }
  }
  if (!reSrc) return null;
  let re;
  try { re = new RegExp(reSrc, 'g'); }
  catch { return null; }

  // Pre-compute line-start offsets for position conversion.
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineColOf = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - lineStarts[lo] };
  };

  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const startOff = m.index;
    const endOff = startOff + m[0].length;
    const startPos = lineColOf(startOff);
    const endPos = lineColOf(endOff);
    const meta = {};
    if (m.groups) {
      for (const [groupName, userName] of captureNames) {
        if (m.groups[groupName] !== undefined) meta[userName] = m.groups[groupName];
      }
    }
    out.push({
      startLine: startPos.line, endLine: endPos.line,
      startCol: startPos.col, endCol: endPos.col,
      text: m[0],
      meta,
    });
    // Prevent zero-length match infinite loop.
    if (m[0] === '') re.lastIndex++;
    if (out.length >= 200) break;   // safety cap
  }
  return out;
}

/**
 * Wrapper: query with tree-sitter if available, else fall back to queryPattern.
 * Currently identical to queryPattern; the wrapper exists so future versions
 * can route through a true AST query when the grammar supports it.
 */
export async function queryWithTreeSitter(src, ext, pattern) {
  return queryPattern(src, pattern);
}

/**
 * Per-language definitions: node type → kind, plus spec for name/body/parent fields.
 *
 * Definitions are intentionally permissive: any missing field is silently
 * skipped. The walker handles each via shared helper functions.
 */
const LANG_DEFS = {
  c: {
    pkg: 'tree-sitter-c',
    types: {
      function_definition: { kind: 'function', name: 'declarator', body: 'body', extractNameFromDeclarator: true },
      struct_specifier: { kind: 'struct', name: 'name', body: 'body' },
      enum_specifier: { kind: 'enum', name: 'name', body: 'body' },
      union_specifier: { kind: 'struct', name: 'name', body: 'body' },
      typedef_declaration: { kind: 'typedef', name: 'declarator', extractNameFromDeclarator: true },
      preproc_def: { kind: 'macro_const', name: 'name' },
      preproc_function_def: { kind: 'macro_func', name: 'name' },
      declaration: { kind: 'global_var', name: 'declarator', extractNameFromDeclarator: true, onlyTopLevel: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  cpp: {
    pkg: 'tree-sitter-cpp',
    types: {
      function_definition: { kind: 'function', name: 'declarator', body: 'body', extractNameFromDeclarator: true },
      function_declaration: { kind: 'function', name: 'declarator', body: 'body', extractNameFromDeclarator: true },
      class_specifier: { kind: 'class', name: 'name', body: 'body' },
      struct_specifier: { kind: 'struct', name: 'name', body: 'body' },
      enum_specifier: { kind: 'enum', name: 'name', body: 'body' },
      union_specifier: { kind: 'struct', name: 'name', body: 'body' },
      namespace_definition: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
      typedef_declaration: { kind: 'typedef', name: 'declarator', extractNameFromDeclarator: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  'c-sharp': {
    pkg: 'tree-sitter-c-sharp',
    types: {
      method_declaration: { kind: 'method', name: 'name', body: 'body' },
      constructor_declaration: { kind: 'method', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      interface_declaration: { kind: 'interface', name: 'name', body: 'body' },
      struct_declaration: { kind: 'struct', name: 'name', body: 'body' },
      enum_declaration: { kind: 'enum', name: 'name', body: 'body' },
      property_declaration: { kind: 'field', name: 'name' },
      field_declaration: { kind: 'field', name: 'declarator', extractNameFromDeclarator: true },
      namespace_declaration: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  python: {
    pkg: 'tree-sitter-python',
    types: {
      function_definition: { kind: 'function', name: 'name', body: 'body' },
      class_definition: { kind: 'class', name: 'name', body: 'body' },
      decorated_definition: { kind: null, passthrough: true },
      import_statement: { kind: 'import', collectImports: true },
      import_from_statement: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['#'],
  },
  go: {
    pkg: 'tree-sitter-go',
    types: {
      function_declaration: { kind: 'function', name: 'name', body: 'body' },
      method_declaration: { kind: 'method', name: 'name', body: 'body' },
      type_declaration: { kind: 'type', name: 'name' },
    },
    comment: 'comment',
    docCommentPrefix: ['//'],
  },
  rust: {
    pkg: 'tree-sitter-rust',
    types: {
      function_item: { kind: 'function', name: 'name', body: 'body' },
      struct_item: { kind: 'struct', name: 'name', body: 'body' },
      enum_item: { kind: 'enum', name: 'name', body: 'body' },
      trait_item: { kind: 'interface', name: 'name', body: 'body' },
      impl_item: { kind: 'class', name: 'type', body: 'body', isImpl: true },
      mod_item: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
      use_declaration: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['//', '/*'],
  },
  java: {
    pkg: 'tree-sitter-java',
    types: {
      method_declaration: { kind: 'method', name: 'name', body: 'body' },
      constructor_declaration: { kind: 'method', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      interface_declaration: { kind: 'interface', name: 'name', body: 'body' },
      enum_declaration: { kind: 'enum', name: 'name', body: 'body' },
      annotation_type_declaration: { kind: 'interface', name: 'name', body: 'body' },
      field_declaration: { kind: 'field', name: 'declarator', extractNameFromDeclarator: true },
      import_declaration: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  kotlin: {
    pkg: 'tree-sitter-kotlin',
    types: {
      function_declaration: { kind: 'function', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      object_declaration: { kind: 'class', name: 'name', body: 'body' },
      interface_declaration: { kind: 'interface', name: 'name', body: 'body' },
      property_declaration: { kind: 'field', name: 'name' },
      import_header: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['//', '/*'],
  },
  scala: {
    pkg: 'tree-sitter-scala',
    types: {
      function_definition: { kind: 'function', name: 'name', body: 'body' },
      class_definition: { kind: 'class', name: 'name', body: 'body' },
      object_definition: { kind: 'class', name: 'name', body: 'body' },
      trait_definition: { kind: 'interface', name: 'name', body: 'body' },
    },
    comment: 'comment',
    docCommentPrefix: ['//', '/*'],
  },
  javascript: {
    pkg: 'tree-sitter-javascript',
    types: {
      function_declaration: { kind: 'function', name: 'name', body: 'body' },
      method_definition: { kind: 'method', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      variable_declaration: { kind: 'const', name: 'declarator', extractNameFromDeclarator: true, onlyTopLevel: true },
      lexical_declaration: { kind: 'const', name: 'declarator', extractNameFromDeclarator: true, onlyTopLevel: true },
      export_statement: { kind: null, passthrough: true },
      import_statement: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  typescript: {
    pkg: 'tree-sitter-typescript',
    types: {
      function_declaration: { kind: 'function', name: 'name', body: 'body' },
      method_definition: { kind: 'method', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      abstract_class_declaration: { kind: 'class', name: 'name', body: 'body' },
      interface_declaration: { kind: 'interface', name: 'name', body: 'body' },
      type_alias_declaration: { kind: 'type', name: 'name' },
      enum_declaration: { kind: 'enum', name: 'name', body: 'body' },
      module_declaration: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
      variable_declaration: { kind: 'const', name: 'declarator', extractNameFromDeclarator: true, onlyTopLevel: true },
      lexical_declaration: { kind: 'const', name: 'declarator', extractNameFromDeclarator: true, onlyTopLevel: true },
      export_statement: { kind: null, passthrough: true },
      import_statement: { kind: 'import', collectImports: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  ruby: {
    pkg: 'tree-sitter-ruby',
    types: {
      method: { kind: 'method', name: 'name', body: 'body' },
      singleton_method: { kind: 'method', name: 'name', body: 'body' },
      class: { kind: 'class', name: 'name', body: 'body' },
      module: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
    },
    comment: 'comment',
    docCommentPrefix: ['#'],
  },
  php: {
    pkg: 'tree-sitter-php',
    types: {
      function_definition: { kind: 'function', name: 'name', body: 'body' },
      method_declaration: { kind: 'method', name: 'name', body: 'body' },
      class_declaration: { kind: 'class', name: 'name', body: 'body' },
      interface_declaration: { kind: 'interface', name: 'name', body: 'body' },
      trait_declaration: { kind: 'interface', name: 'name', body: 'body' },
      namespace_declaration: { kind: 'class', name: 'name', body: 'body', isNamespace: true },
    },
    comment: 'comment',
    docCommentPrefix: ['/*', '/**', '//'],
  },
  bash: {
    pkg: 'tree-sitter-bash',
    types: {
      function_definition: { kind: 'function', name: 'name', body: 'body' },
      variable_assignment: { kind: 'global_var', name: 'name', onlyTopLevel: true },
    },
    comment: 'comment',
    docCommentPrefix: ['#'],
  },
};

/**
 * Parse source text with tree-sitter. Returns Symbol[] or null on failure.
 *
 * @param {string} src
 * @param {string} ext        file extension (without dot), e.g. 'py', 'ts'
 * @param {number} fileId
 * @returns {Promise<Array|null>}
 */
export async function parseWithTreeSitter(src, ext, fileId) {
  if (!await isTreeSitterReady()) return null;
  const pkgName = LANG_BY_EXT[ext];
  if (!pkgName) return null;
  const def = Object.values(LANG_DEFS).find(d => d.pkg === pkgName);
  if (!def) return null;

  const lang = await loadLanguage(pkgName, ext);
  if (!lang) return null;

  let tree;
  try {
    const parser = new _parser();
    parser.setLanguage(lang);
    tree = parser.parse(src);
  } catch (err) {
    return null;
  }
  if (!tree || !tree.rootNode) return null;

  return extractSymbols(tree.rootNode, src, def, fileId, ext);
}

/**
 * Walk the AST and emit Symbol[]. Maintains a parent stack so we can compute
 * qualName and parentSymbolId.
 */
function extractSymbols(root, src, def, fileId, ext) {
  const symbols = [];
  const imports = [];
  const parentStack = [];   // array of { name, symbolId }

  // Pre-compute line-start offsets for byte→line conversion
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (offset) => {
    // binary search
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;  // 1-indexed
  };

  function visit(node, depth) {
    if (!node) return;
    const spec = def.types[node.type];
    if (!spec || spec.passthrough) {
      // Unrecognised or passthrough node (export_statement, decorated_definition):
      // descend into children without emitting a symbol at this level.
      for (const ch of node.namedChildren || []) visit(ch, depth);
      return;
    }

    if (spec.collectImports) {
      const imp = collectImportNames(node, src);
      if (imp.length) imports.push(...imp);
      // Don't descend further into import statements
      return;
    }

    // Skip "onlyTopLevel" specs when not at depth 0
    if (spec.onlyTopLevel && depth > 0) {
      for (const ch of node.namedChildren || []) visit(ch, depth);
      return;
    }

    const name = extractName(node, spec, src);
    if (!name) {
      for (const ch of node.namedChildren || []) visit(ch, depth);
      return;
    }

    const startRow = node.startPosition?.row ?? lineOf(node.startIndex) - 1;
    const endRow = node.endPosition?.row ?? startRow;
    const lineStart = startRow + 1;
    const lineEnd = endRow + 1;
    const id = `${fileId}:${lineStart}`;

    const sig = extractSignature(node, src);
    const body = spec.body ? src.slice(node.startIndex, node.endIndex) : '';
    const refs = collectReferences(node, src, spec.body);
    const doc = precedingDocComment(node, src, def);

    const modifiers = extractModifiers(node, src, def);

    const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;
    const qualName = parent && parent.name
      ? `${parent.name}.${name}`
      : name;

    const sym = {
      id,
      name,
      kind: spec.kind,
      fileId,
      lineStart,
      lineEnd,
      signature: sig,
      body: body.slice(0, 4096),    // cap to keep symbol record reasonable
      modifiers,
      paramNames: extractParamNames(sig, src, node, spec),
      references: refs,
      qualName,
      parentSymbolId: parent ? parent.symbolId : null,
      docString: doc,
    };

    if (spec.kind === 'class' || spec.kind === 'struct') {
      sym.superClass = extractSuperClasses(node, src);
      sym.implements = extractImplements(node, src);
    }

    symbols.push(sym);

    // Descend with this symbol as parent (for classes/namespaces)
    if (spec.kind === 'class' || spec.kind === 'struct' || spec.kind === 'interface' || spec.kind === 'enum' || spec.isNamespace) {
      parentStack.push({ name: qualName, symbolId: id });
      for (const ch of node.namedChildren || []) visit(ch, depth + 1);
      parentStack.pop();
    } else {
      for (const ch of node.namedChildren || []) visit(ch, depth + 1);
    }
  }

  visit(root, 0);

  // File-level imports attached to the first symbol (or as a sentinel)
  if (imports.length > 0 && symbols.length > 0) {
    if (!symbols[0].imports) symbols[0].imports = [];
    symbols[0].imports.push(...imports);
  } else if (imports.length > 0) {
    // file with imports but no symbols; emit a placeholder import symbol
    symbols.push({
      id: `${fileId}:0`,
      name: '__imports__',
      kind: 'import',
      fileId,
      lineStart: 1,
      lineEnd: 1,
      signature: '',
      body: '',
      modifiers: [],
      paramNames: [],
      references: [],
      imports,
      qualName: '__imports__',
      parentSymbolId: null,
      docString: '',
    });
  }

  return symbols;
}

function extractName(node, spec, src) {
  if (spec.extractNameFromDeclarator) {
    // C/C++ declarator field
    const decl = node.childForFieldName?.('declarator') || node.children.find(c => c.type === 'declarator');
    if (decl) return findFirstIdentifier(decl) || null;
    // JS/TS lexical_declaration / variable_declaration: children are variable_declarator nodes
    const vdecls = (node.namedChildren || []).filter(c => c.type === 'variable_declarator');
    if (vdecls.length) {
      // Return first declarator's name; record multi-declarator names as references
      const first = vdecls[0];
      const nameNode = first.childForFieldName?.('name');
      if (nameNode) {
        const txt = nameNode.text || src.slice(nameNode.startIndex, nameNode.endIndex);
        return txt.trim();
      }
      return findFirstIdentifier(first) || null;
    }
    return null;
  }
  if (spec.name) {
    const named = node.childForFieldName?.(spec.name);
    if (named) {
      const txt = named.text || src.slice(named.startIndex, named.endIndex);
      // For "name" field, strip qualifier (e.g. Class::method → method)
      return txt.trim().split(/[.:]+/).pop();
    }
    // Positional fallback: grammars like tree-sitter-kotlin don't expose
    // field names; pick the first identifier-like child as the name.
    const idLike = (node.namedChildren || []).find(c =>
      /identifier$/.test(c.type) || c.type === 'simple_identifier' || c.type === 'type_identifier'
    );
    if (idLike) {
      const txt = idLike.text || src.slice(idLike.startIndex, idLike.endIndex);
      return txt.trim();
    }
  }
  return null;
}

function findFirstIdentifier(node) {
  if (!node) return null;
  // If this node is itself an identifier-ish, return its text
  if (/^identifier$|^(type_identifier|field_identifier|variable_identifier|property_identifier|method_name|function_name|type_name)$/.test(node.type)) {
    return node.text || null;
  }
  for (const ch of node.namedChildren || []) {
    const r = findFirstIdentifier(ch);
    if (r) return r;
  }
  return null;
}

function extractSignature(node, src) {
  // Signature = text from start of node to start of body (or end of node if no body)
  const bodyChild = node.childForFieldName?.('body');
  const endByte = bodyChild ? bodyChild.startIndex : node.endIndex;
  let txt = src.slice(node.startIndex, endByte).trim();
  // Collapse whitespace
  txt = txt.replace(/\s+/g, ' ').trim();
  if (txt.length > 200) txt = txt.slice(0, 200) + '…';
  return txt;
}

function collectReferences(node, src, bodyFieldName) {
  // Collect identifier-like tokens within the body (calls + reads)
  const bodyChild = bodyFieldName ? node.childForFieldName?.(bodyFieldName) : null;
  const scope = bodyChild || node;
  const out = new Set();
  const walk = (n) => {
    if (!n) return;
    if (/^(identifier|field_identifier|property_identifier|type_identifier|call_expression)$/.test(n.type)) {
      const txt = n.text;
      if (txt && /^[A-Za-z_][A-Za-z0-9_]*$/.test(txt) && txt.length <= 64) {
        out.add(txt);
      }
    }
    // For call_expression, capture the function name specifically
    if (n.type === 'call_expression') {
      const fn = n.childForFieldName?.('function');
      if (fn) {
        const t = fn.text;
        if (t && /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) out.add(t);
      }
    }
    for (const ch of n.namedChildren || []) walk(ch);
  };
  walk(scope);
  return Array.from(out);
}

function extractParamNames(sig, src, node, spec) {
  // Extract from the parameter list child if present
  const params = node.childForFieldName?.('parameters');
  if (!params) return [];
  const out = [];
  for (const ch of params.namedChildren || []) {
    const n = findFirstIdentifier(ch);
    if (n) out.push(n);
  }
  return out;
}

function extractSuperClasses(node, src) {
  // class_declaration has 'superclass' field in many grammars
  const out = [];
  const sc = node.childForFieldName?.('superclass');
  if (sc) {
    const t = (sc.text || '').trim();
    if (t) out.push(...t.split(/[,\s]+/).filter(Boolean));
  }
  // C++/Java base_classes / superclass_clause
  const bases = node.childForFieldName?.('base_class');
  if (bases) out.push((bases.text || '').trim());
  // Python: argument_list in class_definition with id 'superclass'
  return [...new Set(out)].filter(s => /^[A-Za-z_][A-Za-z0-9_:.<>]*$/.test(s));
}

function extractImplements(node, src) {
  const out = [];
  // Java: implements interface list; TypeScript: heritage clauses
  for (const ch of node.namedChildren || []) {
    if (ch.type === 'implements_interface' || ch.type === 'super_interfaces' || ch.type === 'heritage') {
      const t = (ch.text || '').trim();
      if (t) out.push(...t.split(/[,\s]+/).filter(Boolean));
    }
  }
  return [...new Set(out)].filter(s => /^[A-Za-z_][A-Za-z0-9_:.<>]*$/.test(s));
}

function extractModifiers(node, src, def) {
  // Modifiers: sibling tokens before the symbol (static, async, public, etc.)
  const out = [];
  const txt = (node.text || '').slice(0, 80);
  for (const m of ['static', 'async', 'public', 'private', 'protected', 'abstract', 'final', 'export', 'exported', 'pub', 'const', 'readonly', 'override']) {
    const re = new RegExp(`\\b${m}\\b`);
    if (re.test(txt)) out.push(m);
  }
  // Go: exported if first letter is uppercase
  return out;
}

function precedingDocComment(node, src, def) {
  const startByte = node.startIndex;
  if (startByte === 0) return '';
  let i = startByte - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return '';

  const commentLines = [];
  while (i >= 0) {
    const lineEnd = i;
    while (i >= 0 && src[i] !== '\n') i--;
    const line = src.slice(i + 1, lineEnd + 1).trim();
    if (!line) break;
    if (!def.docCommentPrefix.some(p => line.startsWith(p))) break;
    commentLines.unshift(line);
    i--;
  }
  if (commentLines.length === 0) return '';

  let text = commentLines.join('\n');
  if (text.startsWith('/*')) {
    text = text.replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
    text = text.replace(/^\s*\*\s?/gm, '');
  } else {
    text = text.replace(/^\s*(\/\/|#)\s?/gm, '');
  }
  return text.trim().slice(0, 1000);
}

function collectImportNames(node, src) {
  // Walk the import node and collect module / symbol names
  const out = new Set();
  const walk = (n) => {
    if (!n) return;
    // Most grammars use 'source' or 'module_name' for the imported path
    if (n.type === 'string' || n.type === 'string_literal') {
      const t = (n.text || '').replace(/^["'`]|["'`]$/g, '');
      if (t) out.add(t);
    }
    if (/^(library_name|module_name|package_name|namespace|qualified_name)$/.test(n.type)) {
      const t = (n.text || '').trim();
      if (t) out.add(t);
    }
    for (const ch of n.namedChildren || []) walk(ch);
  };
  walk(node);
  return Array.from(out);
}
