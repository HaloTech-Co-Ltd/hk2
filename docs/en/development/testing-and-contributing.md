# Testing and contributing

English | [简体中文](../../zh-CN/development/testing-and-contributing.md)

How to run hk2's test suite, what the tests expect from the environment, and
the technical checklist to satisfy before proposing a change. This page
describes only processes that exist in the repository — no CLA, DCO, or
branch policy is imposed beyond what you see here.

## Requirements

- Node.js >= 18 (Node 20 LTS recommended — see
  [Installation](../getting-started/installation.md) for the Tree-sitter
  compatibility notes)
- A checkout of the repository with dependencies installed:

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
```

## Running the tests

The suite uses Node's built-in test runner (`node:test`) — no extra test
framework to install.

```bash
npm test                              # node --test 'test/**/*.test.js'
node --test 'test/**/*.test.js'       # equivalent, direct
node --test test/permissions.test.js  # a single file
```

Run a single test case by name with `--test-name-pattern`:

```bash
node --test --test-name-pattern="deny beats allow" test/permissions.test.js
```

## Where tests live and how they are named

- Tests live in `test/` as `*.test.js` (helpers as `_*.js` / `_*.mjs`,
  e.g. `_tty_env.js`, `_pty_runner.js`, `_learn_setup.js` — not matched by
  the runner glob).
- File names mirror the module under test: `permissions.test.js` →
  `lib/config/setting.js`, `tui_keys.test.js` → `src/tui/keys.js`,
  `llm_retry.test.js` → `lib/llm/retries.js`, and so on.
- Suites that need a real terminal use the PTY runner (`_pty_runner.js`)
  or set up a TTY-like environment via `_tty_env.js`; those tests may
  behave differently (or be skipped) in piped/CI contexts — prefer running
  the full suite in a real terminal when touching TUI/REPL code.
- Tests are hermetic: they redirect `HK2_HOME` to a temp dir rather than
  touching your real `~/.hk2`. Follow that pattern in new tests.

## What to update when you change X

| You changed... | Update... |
|---|---|
| A slash command or its flags | `src/slash/help.js` (help text + completions derive from it), the command implementation, `test/help_system.test.js` / `test/slash_completion.test.js` where applicable, and [Slash commands](../reference/slash-commands.md) in both languages |
| An environment variable | The resolving code, related tests (e.g. `llm_timeout_env.test.js`), and [Environment variables](../reference/environment-variables.md) in both languages |
| The tool registry | `lib/agent/tools.js`, tool tests, and [Agent tools](../reference/agent-tools.md) in both languages |
| A permission rule semantic | `lib/config/setting.js`, `test/permissions.test.js`, and [Security and permissions](../guides/security-and-permissions.md) in both languages |
| A config schema field | `lib/config/home.js`, `setting.example.json` if permission-related, and [Configuration](../reference/configuration.md) in both languages |
| A parser / language mapping | `lib/parser/*`, `package.json` (grammar deps), and [CLI and language support](../reference/cli-and-language-support.md) in both languages |
| Documentation | The matching page in **both** `docs/en/` and `docs/zh-CN/` — see [Documentation maintenance](documentation-maintenance.md) |

## Pre-flight checklist

Before considering a change done:

1. `npm test` passes.
2. `npm run docs:check` passes (bilingual docs stay in sync, links stay
   valid).
3. `node bin/hk2 --help` still prints correct usage if you touched CLI or
   help surfaces.
4. New/changed behavior has a test that fails without the change.
5. No secrets, internal URLs, or personal paths were added to docs or
   examples — use `sk-example`, `http://localhost:8000/v1`,
   `/path/to/project`.
6. Both language versions of any documentation you touched were updated
   together.

## Repo tooling

- `npm run install:global` — `npm link` the checkout (developer install).
- `npm run uninstall:global` — `npm unlink -g hk2`.
- `npm run docs:check` — documentation consistency checks (bilingual
  parity, link targets, quality gates); see
  [Documentation maintenance](documentation-maintenance.md).
- `scripts/close-issues.mjs`, `scripts/learn-once.js` — repo maintenance
  helpers; read the file headers before use.

## Related documentation

- [Documentation maintenance](documentation-maintenance.md) — keeping the docs bilingual and accurate
- [Architecture](architecture.md) — where your change lands
- [Installation](../getting-started/installation.md) — developer install via `npm link`
