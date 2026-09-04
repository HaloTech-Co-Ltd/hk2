<img width="886" height="223" alt="hk2 terminal interface" src="https://github.com/user-attachments/assets/f64c2197-5301-46d2-8984-d659dac5e556" />

# hk2

A knowledge-base (KB) driven agent, purpose-built for coding. Discoveries
made during a session can be distilled into durable knowledge, so later
tasks can start from what earlier ones learned — provided the knowledge was
saved and is retrieved as context.

English | [简体中文](README_zh.md)

## Why hk2

Coding agents forget. Every new session re-reads the same files, re-derives
the same architecture, and re-makes the same mistakes. hk2 flips that: register a
project with `/project init`, build its **knowledge base** with `/kb init`
— symbols, a code knowledge graph, and curated knowledge entries — and for every substantive request hk2 pre-fetches
related KB context into the prompt (clear conversational follow-ups take a
fast lane and let the agent query the KB on demand instead).
Make the KB the source of truth, and the agent gets smarter the more you use
it.

## Core capabilities

- **Three-space KB per project** — Holy Space (stable design knowledge),
  Eden Space (fast-moving catalogs and summaries), Index Space (BM25 +
  graph), each with its own update and approval policy.
- **Tree-sitter AST indexing** — native grammars for 15 languages (14
  packages); regex fallback covers most languages when grammars are
  unavailable (C# has no fallback), turning symbols, call chains, class
  hierarchies, and imports into a queryable graph.
- **Substantive-request context prefetch** — for substantive requests,
  related symbols, call chains, class
  membership, knowledge entries, and docs are retrieved and injected before
  the LLM answers.
- **KB-first agent** — the tool registry steers the agent to KB tools before
  `bash grep`, with mid-turn guardrails; the built-in local path tools run
  behind an r/w/x permission model that denies everything outside the
  project by default.
- **Deep-study** — `/kb knowledge learn` has an LLM survey the codebase (or
  documents) and author reusable knowledge entries; large projects switch
  to directory-level planning automatically.
- **Project Supreme Code** — a protected Holy entry holding the project's
  non-negotiable laws; once you add items they are rendered into every
  system prompt at top priority (model-level compliance — the storage-level
  protections on the entry itself are hard limits).
- **Plans and reviews** — user-confirmed plans with a live progress panel,
  optional plan review and code review of the completed work.
- **Two front-ends, one agent** — a classic line REPL and a Claude
  Code-style TUI (`hk2 --tui`) sharing sessions, commands, and pipeline.

## Requirements

- Node.js >= 18 (Node 20 LTS recommended for Tree-sitter native
  compatibility)
- `npm install` builds the Tree-sitter native bindings; without them hk2
  falls back to regex parsers

## Install

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

Installs a self-contained copy at `~/.hk2`, symlinks `hk2` into your PATH,
and preserves models, projects, theme, KBs, sessions, and logs across
reinstalls (permission files and input history are not preserved — see the
[fixed list](docs/en/getting-started/installation.md#reinstalls-preserve-user-data--with-a-fixed-list)).
Options: `--prefix=<path>`, `--install-dir=<path>`, `--no-npm-install`,
`--preserve-data=off` — or use `npm link` for development. Details:
[Installation](docs/en/getting-started/installation.md).

## Quick start

```bash
hk2
```

Inside the REPL:

```text
# 1. Add a model FIRST (or let `hk2 --tui` import one from Claude Code) —
#    /kb init needs it to generate the summary entries
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel

# 2. Register a project and build its knowledge base
/project init --name=myapp --source=/path/to/repo --source-root=src
/kb init

# 3. Deep-study the project → auto-generate knowledge entries
/kb knowledge learn

# 4. Ask — the agent retrieves KB context and uses tools automatically
How does login verify the password?
```

An illustrative exchange (the prompt, status bar, and tool calls are real
hk2 behavior; the answer below is an example, not output from this repo):

```text
hk2(myapp|Eden/9 Holy/1|local/mymodel)> How does login verify the password?
✎ thinking …
⚡ kb_search("verify password login")
⚡ read(<the source file the search surfaced>)
login() verifies the submitted password against the stored hash, traced
through the related symbols and knowledge entries retrieved from the KB.
```

More: [Quick start](docs/en/getting-started/quick-start.md).

## Documentation

Full documentation in `docs/`, mirrored in English and Chinese:

- **Getting started** — [Installation](docs/en/getting-started/installation.md) ·
  [Quick start](docs/en/getting-started/quick-start.md)
- **Concepts** — [Knowledge base](docs/en/concepts/knowledge-base.md) ·
  [Knowledge graph and retrieval](docs/en/concepts/knowledge-graph-and-retrieval.md) ·
  [Agent workflow](docs/en/concepts/agent-workflow.md)
- **Guides** — [Models, projects, sessions](docs/en/guides/models-projects-and-sessions.md) ·
  [Knowledge workflows](docs/en/guides/knowledge-workflows.md) ·
  [REPL and TUI](docs/en/guides/repl-and-tui.md) ·
  [Planning and review](docs/en/guides/planning-and-review.md) ·
  [Security and permissions](docs/en/guides/security-and-permissions.md) ·
  [Troubleshooting](docs/en/guides/troubleshooting.md)
- **Reference** — [Slash commands](docs/en/reference/slash-commands.md) ·
  [Agent tools](docs/en/reference/agent-tools.md) ·
  [Configuration](docs/en/reference/configuration.md) ·
  [Environment variables](docs/en/reference/environment-variables.md) ·
  [CLI and language support](docs/en/reference/cli-and-language-support.md)
- **Development** — [Architecture](docs/en/development/architecture.md) ·
  [Testing and contributing](docs/en/development/testing-and-contributing.md) ·
  [Documentation maintenance](docs/en/development/documentation-maintenance.md)

Start at the [documentation index](docs/en/README.md), or see all commands
with `/help` inside hk2.

## Supported languages

Native Tree-sitter parsing for C/C++, C#, JavaScript/TypeScript/TSX, Python,
Go, Rust, Java, Kotlin, Scala, Ruby, PHP, and Bash/Zsh; regex fallback
(including Swift, lex/yacc) when grammars are unavailable; document parsing
for Markdown, JSON, YAML, HTML, SGML, PDF, Word, and PowerPoint. Details:
[CLI and language support](docs/en/reference/cli-and-language-support.md).

## Development

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
npm test              # node --test 'test/**/*.test.js'
npm run docs:check    # bilingual docs consistency
node bin/hk2 --help
```

See [Architecture](docs/en/development/architecture.md) and
[Testing and contributing](docs/en/development/testing-and-contributing.md).

## License

[MIT](LICENSE)
