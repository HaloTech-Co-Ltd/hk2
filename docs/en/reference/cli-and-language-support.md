# CLI and language support

English | [简体中文](../../zh-CN/reference/cli-and-language-support.md)

Reference for hk2's command-line interface (flags, one-shot modes, mutual
exclusions) and for which languages get which level of parsing support. The
CLI fact source is `src/cli.js`; the language fact sources are
`package.json` and `lib/parser/*`. `SOURCE_EXT_RE` is a tool-level heuristic
whitelist for bash/read KB-first hints, `read` auto outline/tag, `ast_grep`, and
`ast_edit`; it is not the complete parser or indexer support list and does not
control direct `kb_outline` queries for already indexed files.

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
  instead. "Current project" here means: the current project's KB is used
  only if it was already built; otherwise the build targets a KB named
  `default` (`HK2_KB_NAME` overrides).
- `--mode=project-init` also accepts `--include=<globs>` and
  `--exclude=<globs>` (comma-separated), mirroring `/project init`.

### Legacy run mode

```bash
hk2 --run-mode=serve         # legacy command-style REPL (no agent loop)
```

`--run-mode` accepts `once` or `serve`. `once` is the internal default used
when a `--mode` one-shot command is present; running `hk2 --run-mode=once`
**without** `--mode` is an error, not the interactive mode.

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
| `--name` / `--include` / `--exclude` | strings | `--mode=project-init` operands |
| `--source` / `--source-root` | strings | Operands of **both** `--mode=project-init` and `--mode=build-kb` |
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

Tree-sitter-backed symbols CAN populate the richer fields — qualified
names, parent links, super-classes, implemented interfaces, imports, doc
comments — when the grammar and the extractor expose them; individual
fields remain optional (some languages define no import extraction; some
symbols have no parent, inheritance, or doc string).

> **Glob caveat**: the *default* include globs (see
> [Configuration](configuration.md#default-include--exclude-globs)) do not
> list `**/*.cs` or `**/*.kts`, so C# and Kotlin Script files are parsed
> when encountered but **not scanned by a default `/kb init`**. Because
> `--include` **replaces** the whole default set (it does not append), copy
> the default list from the configuration page, append `**/*.cs` and
> `**/*.kts`, and pass the full list to `/project init --include=...` or
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
standard library. Extension-less convention files (README, LICENSE, CHANGELOG,
CONTRIBUTING, AUTHORS, NOTICE, CHANGES, HISTORY...) are recognized by the
parser — but the *default* include globs only list README*/LICENSE*/
CHANGELOG*/CONTRIBUTING*, so AUTHORS/NOTICE/CHANGES/HISTORY are parsed
only after you add them to the include globs.
`.pdf` requires the optional `pdf-parse` package and Word `.docx` requires
`mammoth`. `.pptx` is extracted via the built-in OOXML ZIP/XML reader, and
the older `.doc` / `.ppt` binaries via a built-in best-effort
printable-text heuristic — the built-in extraction is not a full Office
renderer and does not guarantee recovery of complex layouts, charts,
embedded objects, or every text run. Parsed documents are routed into Eden
Space as `doc:<relpath>` entries.

### Not covered

An extension with no language mapping still gets scanned if an include glob
matches it, but the generic parser returns an empty symbol list for it
(non-document files with no mapping end up in the file registry with zero
symbols). Document formats listed above are handled by the doc parser
instead. Add an explicit language mapping only if you need symbols from a
new extension.

## Related documentation

- [Installation](../getting-started/installation.md) — building the Tree-sitter bindings
- [Knowledge graph and retrieval](../concepts/knowledge-graph-and-retrieval.md) — what parsing feeds
- [Troubleshooting](../guides/troubleshooting.md) — `tree-sitter parse failed` and ABI issues
