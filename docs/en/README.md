# hk2 Documentation

English | [简体中文](../zh-CN/README.md)

Welcome to the hk2 documentation. hk2 is a knowledge-base (KB) driven agent,
purpose-built for coding: every project gets its own KB — symbols, a code
knowledge graph, and distilled knowledge entries — and the agent consults it
on every request, so it starts each new task already knowing what the last
one learned.

New to hk2? Start with [Installation](getting-started/installation.md) and
the [Quick start](getting-started/quick-start.md), then read the
[concepts](#concepts) pages to understand the three-space KB model.

## Getting started

- [Installation](getting-started/installation.md) — requirements, `install.sh`, `npm link`, uninstall, PDF/Word extras
- [Quick start](getting-started/quick-start.md) — from zero to your first KB-driven answer in minutes

## Concepts

- [Knowledge base](concepts/knowledge-base.md) — the three-space model: Holy, Eden, Index; Project Supreme Code
- [Knowledge graph and retrieval](concepts/knowledge-graph-and-retrieval.md) — Tree-sitter parsing, BM25, call/import/inheritance graph, per-request context
- [Agent workflow](concepts/agent-workflow.md) — what happens between pressing Enter and the final answer

## Guides

- [Models, projects, and sessions](guides/models-projects-and-sessions.md) — providers, model registry, phase models, Claude Code import, MCP servers
- [Knowledge workflows](guides/knowledge-workflows.md) — building, updating, studying, and curating a KB
- [REPL and TUI](guides/repl-and-tui.md) — the two interactive front-ends, keys, completion, status bar
- [Planning and review](guides/planning-and-review.md) — plans, the progress panel, plan review, code review
- [Security and permissions](guides/security-and-permissions.md) — the r/w/x permission model and its boundaries
- [Troubleshooting](guides/troubleshooting.md) — symptoms, causes, fixes

## Reference

- [Slash commands](reference/slash-commands.md) — every `/command`, verified against `src/slash/help.js`
- [Agent tools](reference/agent-tools.md) — the tool registry the agent can call mid-turn
- [Configuration](reference/configuration.md) — `HK2_HOME` layout, `models.json`, `projects.json`, KB layout
- [Environment variables](reference/environment-variables.md) — complete list with code-verified defaults
- [CLI and language support](reference/cli-and-language-support.md) — one-shot CLI flags; which languages get Tree-sitter, regex fallback, or doc parsing

## Development

- [Architecture](development/architecture.md) — components, data flow, module boundaries
- [Testing and contributing](development/testing-and-contributing.md) — running the test suite, pre-commit checklist
- [Documentation maintenance](development/documentation-maintenance.md) — how this docs tree stays bilingual and accurate
