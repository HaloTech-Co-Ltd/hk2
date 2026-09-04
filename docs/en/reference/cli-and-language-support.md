# CLI and language support

English | [简体中文](../../zh-CN/reference/cli-and-language-support.md)

Reference for hk2's command-line interface (flags, one-shot modes, mutual
exclusions) and for which languages get which level of parsing support. The
CLI fact source is `src/cli.js`; the language fact sources are
`package.json` and `lib/parser/*`.

## CLI

### Interactive modes (default)

Running `hk2` with no flags enters the interactive REPL (agent loop with
tool use + automatic KB context).

```bash
hk2                          # interactive REPL (default)
hk2 --tui                    # Claude Code-style inline TUI (falls back to REPL without a TTY)
hk2 --repl                   # force the classic line REPL
```

### Project selection and session resume

```bash
hk2 --project=myapp                        # by name
hk2 --project-id=8ce5c38d-214c-4e0d-8ed1-30045dd3c99d   # by UUID
hk2 --project-list                         # list all projects and exit (current marked '*')
hk2 --resume                               # resume the current project's latest session
hk2 --resume 3f9c1a2e                      # resume a specific session
hk2 --project=otherapp --resume            # resume another project's latest session
```

- `--project` and `--project-id` are **mutually exclusive** — pick one.
  Duplicate names are rejected with a hint to use `--project-id`.
- Project selection pins the project for this session (it does not rewrite
  the shared global `current` pointer, so a parallel `hk2 --project=<other>`
  process cannot flip this session's project).
- `--resume` and `--project*` are only meaningful with the default
  interactive mode.

### One-shot modes

```bash
# Register a project (equivalent to /project init in the REPL)
hk2 --mode=project-init --name=myapp --source=/path/to/repo --source-root=src

# Build the KB for the current project (full re-index)
hk2 --mode=build-kb [--source=<path>] [--source-root=<rel>]

# Incrementally update the KB
hk2 --mode=update-kb
```

- `--mode=build-kb` accepts `--source=<path>` and `--source-root=<rel>`.
  When `--source` is omitted it falls back to the unusual default
  `../../../` resolved against the current working directory — prefer
  passing it explicitly, or use `/kb init` inside the interactive REPL
  instead.
- `--mode=project-init` also accepts `--include=<globs>` and
  `--exclude=<globs>` (comma-separated), mirroring `/project init`.

### Legacy run mode

```bash
hk2 --run-mode=serve         # legacy command-style REPL (no agent loop)
```

`--run-mode` accepts `once` (default) or `serve`.

### Version and help

```bash
hk2 --version                # or -V
hk2 --help                   # or -h
```

### Flag summary

| Flag | Values | Notes |
|---|---|---|
| `--tui` / `--repl` | - | Front-end override; beats `HK2_UI` |
| `--project` | `<name>` | Mutually exclusive with `--project-id` |
| `--project-id` | `<uuid>` | Mutually exclusive with `--project` |
| `--project-list` | - | One-shot; exits |
| `--resume` | optional `<sessionId>` | Interactive mode only |
| `--mode` | `project-init`, `build-kb`, `update-kb` | One-shot modes |
| `--run-mode` | `once`, `serve` | `serve` = legacy REPL |
| `--name` / `--source` / `--source-root` / `--include` / `--exclude` | strings | `--mode=project-init` operands |
| `--version` / `-V`, `--help` / `-h` | - | |

## Language support

Support is a ladder, not a boolean — check which rung your language is on.

### Native Tree-sitter parsing (AST-accurate)

14 packages, 15 grammars (`tree-sitter-typescript` exports both `typescript`
and `tsx`):

- C (`.c` `.h`), C++ (`.cpp` `.cc` `.cxx` `.hpp`), C# (`.cs`)
- JavaScript (`.js` `.mjs` `.cjs` `.jsx`), TypeScript (`.ts`), TSX (`.tsx`)
- Python, Go, Rust
- Java, Kotlin (`.kt` `.kts`), Scala
- Ruby, PHP
- Bash (`.sh` `.bash` `.zsh`)

Symbols from these carry the full record: qualified names, parent links,
super-classes, implemented interfaces, imports, doc comments.

> **Glob caveat**: the *default* include globs (see
> [Configuration](configuration.md#default-include--exclude-globs)) do not
> list `**/*.cs` or `**/*.kts`, so C# and Kotlin Script files are parsed
> when encountered but **not scanned by a default `/kb init`**. Add them
> via `/project init --include=**/*.cs,**/*.kts` or
> `/project set include ...`.

### Regex fallback parsers

When Tree-sitter is unavailable (no `npm install`, ABI mismatch, missing
grammar), hk2 transparently falls back to regex-based parsers with lower
coverage but the same `Symbol[]` shape:

- **C / C++** — dedicated C parser (`.c` `.h` `.cpp` `.cc` `.cxx` `.hpp`)
- **lex / yacc** — dedicated parser (`.y` `.l`)
- **Generic parser** — Python, JS/JSX/TS/TSX, Go, Rust, Java, Kotlin,
  Scala, Ruby, PHP, **Swift**, shell

Note the two asymmetries: **Swift** has no Tree-sitter grammar in hk2
(regex only), and **C#** has no regex fallback (Tree-sitter only — without
it, C# files yield no symbols).

### Document formats (doc parser, stdlib)

Markdown (`.md` `.markdown`), plain text (`.txt` `.rst` `.adoc`), JSON,
YAML (`.yaml` `.yml`), HTML (`.html` `.htm`), SGML are parsed with the
standard library. Extension-less convention files (README, LICENSE,
CHANGELOG, CONTRIBUTING, AUTHORS, NOTICE...) are treated as documents.
PDF (`.pdf`) and Word (`.docx`) require the optional `pdf-parse` /
`mammoth` packages; legacy Office binaries (`.doc`, `.pptx`, `.ppt`) are
extracted dependency-free. Parsed documents are routed into Eden Space as
`doc:<relpath>` entries.

### Not covered

Files whose extension matches no mapping above are skipped by the indexer —
no symbols, no document entries. Add an include glob and a fallback only if
you need them.

## Related documentation

- [Installation](../getting-started/installation.md) — building the Tree-sitter bindings
- [Knowledge graph and retrieval](../concepts/knowledge-graph-and-retrieval.md) — what parsing feeds
- [Troubleshooting](../guides/troubleshooting.md) — `tree-sitter parse failed` and ABI issues
