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
3. **Symbol extraction** — every parse returns `Symbol[]` records: name,
   kind (function / method / class / interface / struct / field), line
   range, signature, qualified name, parent, super-classes, implemented
   interfaces, imports, and doc comments.
4. **Index build** — the BM25 inverted index (`lib/index/bm25.js`, tokenizer
   in `lib/index/text_tokenizer.js`, including a CN/EN dictionary for
   mixed-language queries), the legacy callgraph, the knowledge graph
   (`lib/graph/builder.js`), and the file/symbol registries are written to
   `~/.hk2/kb/<projectId>/`.
5. **Summaries** — at the end of `/kb init`, an LLM authors the three
   structural Eden entries (skippable with `--skip-summary`).

Parsing runs in a bounded parallel pool — `HK2_INDEX_PARALLEL` pins the
width (default: auto, the host CPU count respecting cgroup quotas).

## The symbol model

A Symbol record is the common currency of the KB. Both the Tree-sitter path
and the regex fallback emit the same shape; the AST path additionally fills
`qualName`, `parentSymbolId`, `superClass`, `implements`, `imports`, and
`docString`. Everything downstream — BM25, graph, outlines, call chains —
consumes Symbols, which is why a missing grammar only lowers precision
instead of breaking the pipeline.

## The knowledge graph

On `/kb init`, hk2 builds a code knowledge graph from the Symbols:

```
~/.hk2/kb/<projectId>/graph/
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

The graph is queried via the agent tools (see
[Agent tools](../reference/agent-tools.md)):

- `kb_callchain` — bounded DFS over the call graph (forward, backward, both)
- `kb_class` — class / interface / struct lookup with members + implementations
- `kb_refs` — who calls / imports / derives from a symbol
- `kb_implements` — find every class that implements an interface

The REPL-side equivalents are `/kb neighbors` (1-hop) and the tools above.

## BM25 retrieval

`/kb search <query>` and the `kb_search` tool rank symbols by BM25 over the
inverted index, then rerank by name match. By default the user query is first
rewritten by an LLM into English function names + keywords
(`HK2_ENABLE_QUERYREWRITE`, default on; `kb_search` accepts `skip_rewrite`
when you already have identifiers). Top results can carry a ±15-line source
slice so the agent often needs no follow-up `read`.

Knowledge entries are searched separately by `kb_search_knowledge` (keyword
overlap over Holy + Eden titles, keywords, **and intro bodies** — title and
keyword hits dominate the ranking, while intro hits surface entries that
mention the fact only in their body).

## Per-request context injection

For each user message, before the agent loop starts, hk2:

1. Optionally assesses request clarity (see
   [Agent workflow](agent-workflow.md)).
2. Rewrites the query and retrieves related **symbols**, **call chains**,
   **class membership**, **knowledge entries**, and **parsed docs** from the
   KB (`lib/agent/graph.js` + `lib/retrieval/context_builder.js`).
3. Injects them into the system prompt as a `# Knowledge-base context`
   section — placed *after* the Project Supreme Code section, so project
   laws always outrank retrieved knowledge.

KB content that mirrors real files honors the same `r` permission as reading
those files — denied source files are suppressed from snippets, slices, and
injected context while pure metadata stays visible (see
[Security and permissions](../guides/security-and-permissions.md)).

## Incremental updates, checkpoints, and recovery

- **Incremental update** — `/kb update` re-hashes files (sha256) and
  re-parses only the changed ones, then rebuilds the derived indexes. It also
  auto-detects a legacy KB layout and upgrades it losslessly (knowledge
  snapshot to `backup/pre-upgrade-<ts>/` first; a parser-version change
  triggers a full re-index).
- **Checkpoints** — `/kb init` saves a checkpoint every N files
  (`--checkpoint-interval=N`, default `HK2_KB_CHECKPOINT_INTERVAL=100`). If
  the build is interrupted, re-running resumes from the checkpoint — no
  re-parsing of completed files. `--no-checkpoint` disables checkpointing,
  `--no-resume` starts fresh.
- **Large projects** — parsing parallelism scales with the CPU count; the
  `/kb knowledge learn` planner switches from file-level to directory-level
  planning above 300 indexed files (see
  [Knowledge workflows](../guides/knowledge-workflows.md)).

## Related documentation

- [Knowledge base](knowledge-base.md) — the three-space model
- [Agent workflow](agent-workflow.md) — where retrieval sits in the turn pipeline
- [CLI and language support](../reference/cli-and-language-support.md) — which languages get Tree-sitter vs regex parsing
