# Installation

English | [简体中文](../../zh-CN/getting-started/installation.md)

This page covers everything needed to install hk2: requirements, the two
install paths (`install.sh` and `npm link`), the installer's data-preservation
behavior, optional PDF/Word parsing, verification, and uninstalling.

## Requirements

- Technical minimum declared by the package: Node.js **>= 18**. Node 18 and
  20 are EOL; in September 2026 use a currently supported release, preferably
  Node 24 Active LTS. Node 22 Maintenance LTS is a compatibility choice after
  verifying the native Tree-sitter bindings on your platform.
- `npm install` to build the Tree-sitter native bindings (14 language packages)

Release phases above are dated September 2026; consult the
[official Node.js release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
when selecting a runtime later.

> **Tree-sitter compatibility note**: native bindings must be verified on the
> Node/platform combination you deploy. This repository does not maintain a
> cross-version, all-platform binding matrix. If `/kb init` logs
> `tree-sitter parse failed`, try `npm rebuild` in the actual install directory;
> hk2 falls back to regex-based parsers where one exists, while languages
> without a fallback (notably C#) yield no symbols — see
> [CLI and language support](../reference/cli-and-language-support.md).

The installation workflows below use a source checkout.

## Option A — install.sh (recommended)

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

`install.sh` copies the current local source checkout into a self-contained
tree at `~/.hk2`, symlinks `hk2` into your PATH (`/usr/local/bin/hk2` by
default — writing there may need elevated permissions; unprivileged users
can pass `--prefix="$HOME/.local"`), and runs `npm install --omit=optional`
to build the Tree-sitter native bindings. The script itself never clones
anything — run it from a full checkout.

### Reinstalls preserve user data — with a manifest

`~/.hk2` serves two roles: it is the **config / data home** (`HK2_HOME`)
*and* the default **install dir** for the source copy. On a reinstall the
installer stages the data items declared in `config/install-data-items.txt`,
refreshes the code tree, then restores them (user data wins over any
same-named item shipped by the new tree). The installer keeps recoverable
sibling staging and backup directories and resumes an interrupted upgrade on
the next run. This protects the upgrade process, but it is not a substitute
for an external backup of important data:

- **Preserved**: `models.json`, `projects.json`, `theme.json`, `setting.json`,
  `history.jsonl`, `welcome-seen`, `settings/`, `kb/`, `sessions/`, and
  `logs/`. The checked-in manifest is the authoritative list.

Preservation applies only to matching top-level entries already inside the
chosen `HK2_INSTALL_DIR`; the installer does not search a separate custom
`HK2_HOME` or `HK2_KB_DIR`. Conversely, data stored outside the install target
is not touched by refreshing that target. The source tree is first copied to a
unique sibling stage. Existing listed data moves to `.hk2-preserve`, the old
installation moves to `.hk2-old`, and those recovery directories are removed
only after the new launcher has been verified and every manifest-recorded item
is present. A later run detects an interrupted preserve transaction and tries
to restore its recorded items before starting the next upgrade. This recovery
is filesystem best-effort rather than an atomic multi-directory transaction;
retain an external backup.

Failure to run `npm install` prints a warning and continues with regex parser
fallbacks; if the launcher verification succeeds, that warning does not keep
the old installation backup. Failures in staging, tree replacement, data
restoration, or launcher verification leave the sibling recovery state for a
later run where applicable.

The destructive legacy wipe requires both `--preserve-data=off` and
`--confirm-data-loss`.

If you already have a checkout and actively develop on hk2, prefer
`npm link` (Option B), or set `HK2_INSTALL_DIR` to keep the source copy out
of the config home.

### Installer options

| Option | Effect |
|---|---|
| `--prefix=<path>` | Install prefix for the `hk2` symlink (default `/usr/local`; also settable via the `HK2_PREFIX` env var) |
| `--install-dir=<path>` | Location of the self-contained source copy (default `~/.hk2`; also settable via `HK2_INSTALL_DIR`) |
| `--no-npm-install` | Skip `npm install`; without native bindings, only languages with regex fallbacks produce code symbols |
| `--preserve-data=off` | Legacy behavior: do **not** preserve manifest-listed data in the install target during reinstall; requires the confirmation flag |
| `--confirm-data-loss` | Required confirmation for `--preserve-data=off`; has no destructive effect by itself |

Both `--prefix=value` and `--prefix value` forms are accepted; the same goes
for `--install-dir`.

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # same as default
HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh   # keep the source copy out of the config home
./install.sh --no-npm-install             # skip Tree-sitter (regex fallback)
./install.sh --preserve-data=off --confirm-data-loss  # destructive reinstall
```

### Optional PDF / Word parsing

`pdf-parse` (PDF) and `mammoth` (Word `.docx`) are optional dependencies —
the installer omits them to keep the base install light. To enable them:

```bash
cd ~/.hk2 && npm install                  # installs pdf-parse + mammoth (use your actual install dir if HK2_INSTALL_DIR was set)
```

`.pptx` is extracted via the built-in OOXML ZIP/XML reader; the older
`.doc` / `.ppt` binaries via a built-in best-effort printable-text heuristic
(neither is a full Office renderer — complex layouts, charts, embedded
objects, or every text run are not guaranteed to be recovered). Only PDF
and `.docx` need the optional packages.

## Option B — npm link (for developers)

Creates a live symlink to the working tree. Useful if you are hacking on hk2
itself and want changes to take effect immediately.

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
npm install
npm link
```

Uninstall: `npm unlink -g hk2` (or `npm run uninstall:global`).

## Verify

```bash
hk2 --help
hk2 --version
```

`hk2 --help` prints the version, CLI usage, the slash-command families, and
the config locations. If it does, the launcher and the Node runtime are both
working.

## Uninstall

There is no uninstaller; what to remove depends on what you want to keep.

**Disable the command only** — remove the launcher; everything else stays:

```bash
rm -f /usr/local/bin/hk2
```

**Remove the installed source copy** — `install.sh` copies the *whole*
repository into the install dir, so with the default `~/.hk2` the code and
your user data (`models.json`, `projects.json`, `kb/`, `sessions/`, `logs/`)
live in the same tree, and there is no single command that removes the code
while provably keeping the data. A partial cleanup such as:

```bash
rm -rf ~/.hk2/node_modules ~/.hk2/bin     # removes SOME installed files — not the full copy
```

still leaves `src/`, `lib/`, `package.json`, `install.sh`, and other repo
files behind. It is harmless, but it is not a complete removal.

**Clean removal** — if you want code and data separable, install with a
dedicated source directory in the first place
(HK2_INSTALL_DIR="$HOME/.hk2-src" ./install.sh); uninstalling is then just:

```bash
rm -f /usr/local/bin/hk2
rm -rf "$HOME/.hk2-src"                   # the whole source copy, data untouched
```

To remove the **default data home**, including models, projects, sessions,
and knowledge bases stored there: `rm -rf ~/.hk2` — back up what you want to
keep first. Data under custom `HK2_HOME` / `HK2_KB_DIR` paths and a separate
source installation are outside this command's scope.

## Related documentation

- [Quick start](quick-start.md) — first project, first KB, first question
- [Configuration](../reference/configuration.md) — what lives inside `HK2_HOME`
- [Troubleshooting](../guides/troubleshooting.md) — Tree-sitter ABI issues and fallbacks
