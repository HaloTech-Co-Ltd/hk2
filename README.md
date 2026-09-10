# hk2

English | [简体中文](README_zh.md)

**Build on what your project already knows.**

hk2 is a coding agent powered by a project knowledge base. It brings code
structure, design knowledge, and task experience into searchable context,
helping you understand code, make changes, and preserve useful discoveries
for retrieval in future tasks.

[Quick start](#quick-start) · [Documentation](docs/en/README.md) · [Architecture](docs/en/development/architecture.md)

<img width="886" height="223" alt="hk2 terminal interface" src="https://github.com/user-attachments/assets/f64c2197-5301-46d2-8984-d659dac5e556" />

## Why hk2

Understanding a project means knowing how its code connects, why its design
looks the way it does, and which conventions a change must respect. That
understanding deserves to outlast a single conversation.

hk2 combines symbol indexes, a code knowledge graph, and maintainable
knowledge entries. It guides the agent to retrieve project knowledge, verify
against source, and act. Explore unfamiliar code through call chains, work
through complex changes with plans and reviews, and save design decisions
and task experience for the next piece of work.

Knowledge becomes useful through maintenance and retrieval; hk2 does not
automatically remember every conversation. Learn
[how the KB is organized](docs/en/concepts/knowledge-base.md) and
[how context enters a task](docs/en/concepts/agent-workflow.md).

## Core capabilities

- **Explore the relationships in your code** — Tree-sitter symbol indexing
  and a code knowledge graph connect searches to source through call chains,
  class hierarchies, and imports.
- **Reuse knowledge across tasks** — Holy Space (stable design knowledge),
  Eden Space (catalogs and summaries), and Index Space (search indexes and
  graph) organize project context in layers. Deep-study can distill reusable
  knowledge entries from code and documents.
- **Bring project conventions into the workflow** — Project Supreme Code
  injects saved rules into system prompts as high-priority guidance; model
  compliance still needs verification. Local tools provide read, write, and
  execute permission controls; see [Security and permissions](docs/en/guides/security-and-permissions.md).
- **Keep complex work visible** — interactive plan confirmation, live
  progress, and optional plan and code reviews help you assess the approach
  and inspect the result.
- **Choose your terminal experience** — a classic line REPL and an inline
  TUI (`hk2 --tui`) share agent capabilities, sessions, and commands.

## Requirements

- The package requires Node.js >= 18. See the
  [installation guide](docs/en/getting-started/installation.md) for supported
  release selection and native binding compatibility.
- `npm install` builds the Tree-sitter native bindings. Most languages can
  fall back to regex parsing when bindings are unavailable; C# cannot.

## Install

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

Installs a self-contained copy at `~/.hk2`, symlinks `hk2` into your PATH,
and preserves the user-data entries declared in
`config/install-data-items.txt` across reinstalls. Interrupted upgrades are
recoverable; intentionally discarding data requires both
`--preserve-data=off` and `--confirm-data-loss`.
For custom paths, reinstall options, and development installs, see
[Installation](docs/en/getting-started/installation.md).

## Quick start

```bash
hk2
```

Complete these three steps inside the REPL. Replace the model name, endpoint,
API key, and project path with your own settings. This example uses a local
OpenAI-compatible service; `src` is the project's source subdirectory.

```text
# 1. Connect a model
/model add local mymodel --api=openai --base-url=http://localhost:8000/v1 --api-key=sk-example
/model set-default local/mymodel

# 2. Register a project and build its knowledge base
/project init --name=myapp --source=/path/to/repo --source-root=src
/kb init

# 3. Start exploring the project
How does login verify the password?
```

You can ask questions as soon as indexing finishes. Optionally run
`/kb knowledge learn` to distill further project knowledge; large projects
may require more time and model usage. `hk2 --tui` also supports importing
model configuration from Claude Code; see
[Model configuration](docs/en/guides/models-projects-and-sessions.md).

An illustrative exchange in a project with a login module, showing retrieval
and source inspection (example output):

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
Go, Rust, Java, Kotlin, Scala, Ruby, PHP, and Bash/Zsh. Most languages have
regex fallback when grammars are unavailable (C# does not); Swift and lex/yacc
also have regex parsing support. Document parsers cover Markdown, JSON,
YAML, HTML, SGML, PDF, Word, and PowerPoint. Details:
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
