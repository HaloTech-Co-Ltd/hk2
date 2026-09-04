# Security and permissions

English | [简体中文](../../zh-CN/guides/security-and-permissions.md)

This guide documents hk2's filesystem permission model: what the agent may
read, write, and execute; where the rules live; how they resolve; and —
explicitly — what the model does *not* protect. It is verified against
`lib/config/setting.js` and `setting.example.json`.

## The r / w / x model

hk2 restricts every built-in local path tool (`read` / `write` / `edit` /
`find` / `grep` / `ast_grep` / `ast_edit` / `resolve`, plus best-effort
scanning of `bash` commands) with a Unix-style permission model:

- `r` — read a file / list a directory
- `w` — create / modify / delete
- `x` — execute (bash commands referencing the path)

- **Inside the project: permissive by default.** Paths inside the current
  project roots (`cwd` + `HK2_PROJECT_SOURCE`) are fully operable — `rwx`
  for files and directories — unless an explicit rule or the hard-denied
  config paths override it (an `allow: r` rule on a project path makes it
  read-only; see below).
- **Outside the project: default deny.** Any path outside those roots is
  denied unless a rule grants it.
- A rule on a directory covers **everything inside it** (like directory
  permission bits); a rule on a file covers just that file. Rules are always
  recursive — a trailing `/**` is accepted and equivalent to the bare
  directory.

## Configuration files

Two layers are merged (see `setting.example.json` at the repo root). Both
live under `HK2_HOME`, which defaults to `~/.hk2` and sits outside the
project tree — but since `HK2_HOME` can point anywhere, the real guarantee
is different: **writes to `setting.json` and `settings/**` are hard-denied
for the agent no matter where they live**, so the model cannot rewrite the
rules that bound its own sandbox:

> **Reinstall warning**: when the install dir is also `~/.hk2` (the
> default), re-running `install.sh` from an outside checkout **deletes
> `setting.json` and `settings/`** — they are not on the installer's
> preserve list (only models/projects/theme/kb/sessions/logs are). Back them
> up first or install with a separate `HK2_INSTALL_DIR`; see
> [Installation](../getting-started/installation.md).

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
entry — only the offending rule is dropped and every other valid rule keeps
working. The base policy is unchanged by the drop: outside the project
roots everything stays denied; inside them the permissive project default
still applies. An empty `permissions: []` array is a valid "no rules"
config and produces no warning.

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

A `read` deny on a source file suppresses the KB channels that explicitly
mirror file content:

- **Filtered channels** (suppressed when the source file is denied):
  `kb_search` snippets and source slices (slices additionally skip files
  over 512 KiB), `kb_symbol` / `kb_outline` / `kb_class` doc strings, and
  the per-turn auto-injected KB context (symbol snippets, collected doc
  texts, structured doc tables).
- **Still visible even after a deny** — index-derived material that is NOT
  re-filtered against the original file's read permission: symbol names,
  qualified names, kinds, **signatures** (source-derived: parameter names,
  types, defaults), line ranges, graph relationships
  (imports/inheritance/containment), and stored Holy/Eden knowledge-entry
  bodies — including `doc:<relpath>` Eden entries whose `intro` is derived
  from the original document text, `kb_search_knowledge` intro previews,
  and the full entries returned by `kb_knowledge` (which may read the
  on-disk knowledge store directly).

> **Confidentiality warning**: a read deny is **not** currently a complete
> confidentiality boundary for data indexed before the rule was applied. It
> suppresses the explicitly filtered mirrored-content channels listed
> above, but source-derived signatures, graph metadata, and stored
> Holy/Eden entry bodies may remain visible. When confidentiality requires
> removing already-indexed material, rebuild or delete the affected KB
> data.

## Credentials and file permissions

- Inputs matching the current credential-detection patterns
  (`--api-key=…`, `--token=…`, `Authorization` headers,
  `password=`/`secret=` values) are not written to the input history. The
  detection is pattern-based — it covers these common shapes, not every
  possible way of typing a secret.
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
- any constraint **inside** an MCP server. The local permission service
  checks the built-in tools (`read`/`write`/`edit`/`find`/`grep`/`ast_*`
  ...); an external MCP server's own file or network access is not gated by
  these path checks — trust and restrict MCP servers independently.

## Related documentation

- [Configuration](../reference/configuration.md) — file layout under `HK2_HOME`
- [Agent tools](../reference/agent-tools.md) — which tools touch paths
- [Troubleshooting](troubleshooting.md) — permission-denied diagnostics
