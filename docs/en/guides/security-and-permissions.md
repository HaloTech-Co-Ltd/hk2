# Security and permissions

English | [简体中文](../../zh-CN/guides/security-and-permissions.md)

This guide documents hk2's filesystem permission model: what the agent may
read, write, and execute; where the rules live; how they resolve; and —
explicitly — what the model does *not* protect. It is verified against
`lib/config/setting.js` and `setting.example.json`.

## The r / w / x model

hk2 restricts every path-touching agent tool (`read` / `write` / `edit` /
`find` / `grep` / `ast_grep` / `ast_edit` / `resolve`, plus best-effort
scanning of `bash` commands) with a Unix-style permission model:

- `r` — read a file / list a directory
- `w` — create / modify / delete
- `x` — execute (bash commands referencing the path)

- **Inside the project: permissive by default.** Paths inside the current
  project roots (`cwd` + `HK2_PROJECT_SOURCE`) are fully operable — `rwx`
  for files and directories. Your own project is trusted.
- **Outside the project: default deny.** Any path outside those roots is
  denied unless a rule grants it.
- A rule on a directory covers **everything inside it** (like directory
  permission bits); a rule on a file covers just that file. Rules are always
  recursive — a trailing `/**` is accepted and equivalent to the bare
  directory.

## Configuration files

Two layers are merged (see `setting.example.json` at the repo root). **Both
live under `HK2_HOME` — deliberately outside the agent-writable project
tree, so the model can never rewrite the rules that bound its own sandbox**:

- `~/.hk2/setting.json` — global baseline
- `~/.hk2/settings/<project-id>/setting.json` — per-project override

The project id comes from `HK2_PROJECT_ID` (set automatically in interactive
mode) or is resolved from `projects.json` by source path; an unregistered
project simply has no project layer.

```json
{
  "permissions": [
    { "path": "/tmp/scratch",      "allow": "rw"  },
    { "path": "~/Documents/notes", "allow": "r"   },
    { "path": "secrets",           "deny":  "rwx" },
    { "path": "node_modules",      "deny":  "w"   }
  ]
}
```

Relative paths resolve against the project root; `~` expands to the user
home.

> **Migration note**: before this layout existed, the per-project file was
> `<project-root>/setting.json`. That location is **ignored** now — the
> agent can write the project root, so a project-root rules file could be
> self-granted. Move your rules to
> `~/.hk2/settings/<project-id>/setting.json` (or merge them into the global
> file). The warning printed at load time names both paths.

## Rule resolution

**Longest matching prefix wins**; on equal prefixes the project layer beats
the global layer, and `deny` beats `allow` within a layer.

An `allow` rule listing only `r` means **read-only** — it does not fall back
to the permissive inside-project default. Explicit rules fully determine the
mode set for their target.

Invalid config (e.g. `"allow": "q"`, a missing `allow`/`deny` field, or an
entry carrying both) is reported as a load-time warning naming the dropped
entry — only the offending rule is dropped, the system degrades to
deny-by-default rather than crashing, and every other rule keeps working. An
empty `permissions: []` array is a valid "no rules" config and produces no
warning.

## What is enforced where

### Hardened path: the file tools

`read` / `write` / `edit` / `find` / `grep` / `ast_grep` / `ast_edit` /
`resolve` check permissions directly before touching a path.

- **Recursive tools** (`find` / `grep` / `ast_grep` / `ast_edit` directory
  expansion) re-check `r` on every directory they descend into and every
  file they emit — a `deny` rule on a subdirectory holds even when the walk
  started at an ancestor (e.g. the project root).
- Writes staged by `ast_edit` are re-verified per file at `resolve` time.

### Best-effort path: `bash`

`bash` enforcement scans the command string for explicit absolute /
`../`-style paths, slash-bearing relative operands (resolved against the
command's effective base directory, tracked through `cd` sequences), and
executed targets (interpreter operands like `bash script.sh` / `node x.js`,
or a directly invoked absolute binary). Executed targets require `x`; data
operands require `r` (read-only commands) or `w` (mutating commands like
`rm` / `mv` / redirects).

> **A shell is Turing-complete.** This scan is a guardrail against
> accidental damage, not a hard sandbox — a command can construct paths the
> scanner cannot see. The dedicated file tools are the hardened path; treat
> `bash` permission checks as best-effort.

### Agent read-only configuration

Even when an `allow` rule covers `HK2_HOME`, write access to
`~/.hk2/setting.json` and anything under `~/.hk2/settings/` is hard-denied
for the agent — only the human user edits the sandbox definition.

## Symlinks

A path that is lexically inside the project but resolves (via symlink) to an
outside location is denied — the real path is re-checked with the same
rules. Conversely, an `allow` rule written against either spelling (lexical
or real) matches both, so allow rules stay useful on symlinked systems.

## The KB inherits source-file permissions

KB surfaces that mirror real file content follow the same `r` permission as
a `read()` of the source file:

- suppressed when the source file is denied: `kb_search` snippets and
  slices, `kb_symbol` / `kb_outline` / `kb_class` doc strings, the per-turn
  auto-injected KB context (symbol snippets, doc texts, structured doc
  tables), and slice loading;
- still visible (pure metadata, no file content): names, kinds, signatures,
  line ranges, knowledge entries — so navigation keeps working.

## Credentials and file permissions

- Inputs carrying credentials (`--api-key=…`, `--token=…`, `Authorization`
  headers, `password=`/`secret=` values) are never written to the input
  history.
- `~/.hk2` is created 0700; `models.json`, `projects.json`, and
  `~/.hk2/history.jsonl` are kept owner-only (0600, migrated on boot).
- MCP server options store the `$APIKEY` placeholder — the provider key is
  substituted at use time and never persisted inside the options.

## Limits and threat model

What this model is designed to provide:

- a hard boundary for the **structured file tools** outside the project;
- protection of the permission configuration itself from agent writes;
- enforcement of source-file read permissions through KB-derived content.

What it does **not** provide:

- a full OS-level sandbox. `bash` checking is a lexical best-effort scan;
  determined or obfuscated shell code can evade it. Run hk2 with the same
  care you would give any coding agent: least-privilege rules, no secrets in
  reachable paths, and untrusted code reviewed before execution.
- network isolation. Nothing restricts what the agent's `bash` commands or
  MCP servers can reach over the network.

## Related documentation

- [Configuration](../reference/configuration.md) — file layout under `HK2_HOME`
- [Agent tools](../reference/agent-tools.md) — which tools touch paths
- [Troubleshooting](troubleshooting.md) — permission-denied diagnostics
