# Knowledge graph and retrieval

English | [简体中文](../../zh-CN/concepts/knowledge-graph-and-retrieval.md)

This page explains how hk2 turns a source tree into a searchable knowledge
base: file scanning, Tree-sitter AST parsing with regex fallback, the symbol
model, the BM25 index, the code knowledge graph, and how per-request
retrieval feeds the agent its context.

## The indexing pipeline

`/kb init` (and the incremental `/kb update`) run this pipeline:

```mermaid
flowchart LR
    A[Walk files<br/>include/exclude globs<br/>+ .gitignore] --> B[Parse each file<br/>Tree-sitter AST<br/>or regex fallback]
    B --> C[Symbol\[\] records]
    C --> D[BM25 inverted index]
    C --> E[Knowledge graph<br/>nodes + edges]
    C --> F[File registry<br/>+ sharded symbol table]
    G[Documents<br/>md/pdf/docx/...] --> H[Doc parser] --> I[Eden doc: entries]
    G --> K[Doc graph<br/>links, tables, code blocks,<br/>doc-to-doc + doc-to-symbol refs]
    K --> L[doc_index.json]
    C --> J[LLM summaries<br/>project-overview etc.]
```

1. **File scanning** — `lib/index/walker.js` walks the project roots,
   honoring include/exclude globs (defaults cover common source and document
   extensions) and `.gitignore` rules (`lib/index/gitignore.js`).
   `sourceRoot` and extra roots registered with the project all get walked.
2. **Parsing** — `lib/parser/ast.js` dispatches per file extension. When the
   Tree-sitter native binding is available and a grammar exists for the
   extension, `lib/parser/ts_parser.js` produces an AST walk; otherwise the
   file falls back to dedicated regex parsers (C/C++, lex/yacc) or the
   generic regex parser. Documents (Markdown, JSON, YAML, HTML, SGML, PDF,
   Word, PowerPoint, plain text) go through `lib/parser/doc_parser.js` and
   are routed into Eden Space as `doc:<relpath>` entries.
3. **Symbol extraction** — each source-code parser path returns a common
   `Symbol[]` shape: name, kind (function / method / class / interface /
   struct / field), and line range, with signature and richer fields such as
   `qualName`, parent, inheritance, imports, and `docString` when applicable
   and exposed by the extractor. Document parsing follows a separate
   document-entry/document-graph path rather than the ordinary Symbol parse.
4. **Index build** — the BM25 inverted index (`lib/index/bm25.js`, tokenizer
   in `lib/index/text_tokenizer.js`, including a CN/EN dictionary for
   mixed-language queries), the legacy callgraph, the knowledge graph
   (`lib/graph/builder.js`), and the file/symbol registries are written to
   `$HK2_KB_DIR/<projectId>/`, defaulting to `$HK2_HOME/kb/<projectId>/`.
5. **Summaries** — at the end of `/kb init`, **when a model is configured
   and `--skip-summary` is not passed**, an LLM authors the three structural
   Eden entries. Without a configured LLM the index is still built; only the
   summary entries are skipped.

Parsing runs in a bounded parallel pool — `HK2_INDEX_PARALLEL` pins the
width (default: auto, the host CPU count respecting cgroup quotas).

## The symbol model

A Symbol record is the common currency of the KB. Every source-code parser path
emits the same `Symbol[]` shape. Tree-sitter-backed symbols can populate optional
rich fields such as `qualName`, `parentSymbolId`, `superClass`, `implements`,
`imports`, and `docString` when the grammar and extractor expose them. Everything downstream — BM25, graph, outlines, call chains —
consumes Symbols, so a missing grammar lowers precision for languages that
HAVE a regex fallback — and produces no symbols at all for languages without
one (notably C#).

## The knowledge graph

On `/kb init`, hk2 builds a code knowledge graph from the Symbols:

```text
$HK2_KB_DIR/<projectId>/graph/  # default: $HK2_HOME/kb/<projectId>/
  nodes.json            id → node record (function / method / class / interface / struct / field)
  edges.calls.json      srcId → [calleeIds, ...]
  edges.imports.json    srcId → [importedFileNodeIds, ...]
  edges.inherits.json   srcId → [baseClassIds, ...]
  edges.contains.json   srcId → [memberIds, ...]
  by_kind.json          kind → [nodeIds, ...]
  by_qual.json          qualName → nodeId
  meta.json             counts + version
```

Edge kinds:

- **calls** — function/method call relationships (resolved to symbol ids where possible)
- **imports** — file-level import edges between the symbols they define
- **inherits** — class → base-class edges
- **contains** — class → member (method/field) containment

Besides the per-symbol graph, hk2 builds a **document graph**
(`lib/index/doc_graph.js`, persisted via `doc_index.json`): Markdown links
between documents, tables and code blocks extracted from docs, references
between documents, and references from documents to indexed source symbols.
Query-relevant structured tables and doc↔code references are surfaced with
the per-request context.

The graph is queried via the agent tools (see
[Agent tools](../reference/agent-tools.md)):

- `kb_callchain` — bounded BFS over the call graph (forward, backward, both)
- `kb_class` — class / interface / struct lookup with members + implementations
- `kb_refs` — who calls / imports / derives from a symbol
- `kb_implements` — find the direct classes implementing an interface (one hop)

The REPL-side equivalents are `/kb neighbors` (1-hop) and the tools above.

## BM25 retrieval

Both interfaces query the same BM25 symbol index, but they are different
wrappers with different defaults:

| Interface | Rewrite | Default results | Source slices |
|---|---:|---:|---:|
| `/kb search` | No | 20 | No |
| Agent `kb_search` | When an LLM is attached and `skip_rewrite` is not true | 10, clamped 5–50 | Top 3 by default |

`/kb search <query>` passes the user's query directly to `codeSearch()` and
prints names, kinds, files, line numbers, scores, and signatures. It does not
read `HK2_ENABLE_QUERYREWRITE`, rewrite the query, or attach ±15-line slices.
The Agent `kb_search` tool can attempt an inline LLM rewrite independently of
the turn-start `HK2_ENABLE_QUERYREWRITE` flag; `with_slice=false` disables its
source slices. Knowledge entries use a separate flat token-overlap algorithm: `kb_search_knowledge`
scans `rt.allKnowledge()` and joins id, title, intro, and keywords into one
haystack. Each whitespace token contributes at most one equal-weight point,
with no title/keyword bonus; its default is 5 results, clamped to 1–20. It also
does not filter `supersededBy` Eden entries. Turn-start `matchPrinciples()` is
different: Holy and active Eden are matched separately, head fields (topic/title/
keywords) are the primary signal, intro is capped at 2000 characters and weighted
0.3, and only the top 2 are returned; `buildRequestGraph()` excludes retired Eden
and suppresses Holy conflicts.

## Per-request context injection

For each substantive user message, before the agent loop starts, hk2 may
run (each stage is gated — clear conversational follow-ups take the
fast lane and skip all of them; rewrite and assessment can be disabled by
environment variables; assessment runs only where interactive prompting is
available):

1. Rewrites the query into retrieval terms (LLM call — see
   [Agent workflow](agent-workflow.md) for the full pre-agent pipeline).
2. Retrieves related **symbols**, **call chains**, **class membership**,
   **knowledge entries**, and **parsed docs** from the KB
   (`lib/agent/graph.js` + `lib/retrieval/context_builder.js`).
3. Only then assesses request clarity — deliberately **after** the first
   retrieval, so the assessor judges against the retrieved project context;
   an unclear verdict triggers a clarification menu, then a second rewrite +
   retrieval pass.
4. Injects the results into the system prompt as a
   `# Knowledge-base context` section — placed *after* the Project Supreme
   Code section, so project laws always outrank retrieved knowledge.

KB content that mirrors real files honors the same `r` permission as reading
those files — denied source files are suppressed from snippets, slices, and
injected context while pure metadata stays visible (see
[Security and permissions](../guides/security-and-permissions.md)).

## Incremental updates, checkpoints, and recovery

- **Incremental update** — `/kb update` re-hashes files (sha256) and
  incrementally parses changed source files, rebuilds symbol/index/graph
  derived structures, rebuilds `doc_index.json`, and synchronizes
  parser-owned `doc:<relpath>` Eden entries (including removing stale entries
  for deleted or excluded documents). It also auto-detects a legacy KB layout:
  knowledge entries are backed up to
  `backup/pre-upgrade-<ts>/` first, then the migration is applied (a
  parser-version change triggers a full re-index).
- **Checkpoints** — `/kb init` saves a checkpoint every N files
  (`--checkpoint-interval=N`, default `HK2_KB_CHECKPOINT_INTERVAL=100`).
  After an interruption, re-running resumes from the most recent saved
  checkpoint: files recorded there are skipped, while work done after that
  checkpoint but before the next save is re-done. `--no-checkpoint` disables
  checkpointing, `--no-resume` starts fresh.
- **Large projects** — parsing parallelism scales with the CPU count; the
  `/kb knowledge learn` planner switches from file-level to directory-level
  planning above 300 indexed files (see
  [Knowledge workflows](../guides/knowledge-workflows.md)).

## Related documentation

- [Knowledge base](knowledge-base.md) — the three-space model
- [Agent workflow](agent-workflow.md) — where retrieval sits in the turn pipeline
- [CLI and language support](../reference/cli-and-language-support.md) — which languages get Tree-sitter vs regex parsing
