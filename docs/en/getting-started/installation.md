# Installation

English | [简体中文](../../zh-CN/getting-started/installation.md)

This page covers everything needed to install hk2: requirements, the two
install paths (`install.sh` and `npm link`), the installer's data-preservation
behavior, optional PDF/Word parsing, verification, and uninstalling.

## Requirements

- Node.js **>= 18** (Node 20 LTS recommended for Tree-sitter native compatibility)
- `npm install` to build the Tree-sitter native bindings (14 language packages)

> **Tree-sitter compatibility note**: very new Node versions (e.g. Node 25+)
> may have N-API / V8 ABI mismatches with the prebuilt Tree-sitter binaries
> on some platforms. If `/kb init` logs `tree-sitter parse failed`, hk2
> transparently falls back to its regex-based parsers — symbol coverage is
> somewhat lower but the system is fully functional. For maximum precision,
> install on Node 20 LTS or run `npm rebuild` to recompile from source.

hk2 is not published to npm. Install from source.

## Option A — install.sh (recommended)

```bash
git clone https://github.com/HaloTech-Co-Ltd/hk2.git hk2 && cd hk2
./install.sh
```

`install.sh` creates a self-contained copy of the source tree at `~/.hk2`,
symlinks `hk2` into your PATH (`/usr/local/bin/hk2` by default), and runs
`npm install --omit=optional` to build the Tree-sitter native bindings.

### Reinstalls preserve user data

`~/.hk2` serves two roles: it is the **config / data home** (`HK2_HOME` —
`models.json`, `projects.json`, `theme.json`, `kb/`, `sessions/`, `logs/`)
*and* the default **install dir** for the source copy. Reinstalls **preserve
user data**: the installer moves those data items aside, refreshes the code
tree, then moves them back (user data wins over any same-named item shipped
by the new tree). Pass `--preserve-data=off` for the legacy wipe behavior.

If you already have a checkout and actively develop on hk2, prefer
`npm link` (Option B), or set `HK2_INSTALL_DIR` to keep the source copy out
of the config home.

### Installer options

| Option | Effect |
|---|---|
| `--prefix=<path>` | Install prefix for the `hk2` symlink (default `/usr/local`; also settable via the `HK2_PREFIX` env var) |
| `--install-dir=<path>` | Location of the self-contained source copy (default `~/.hk2`; also settable via `HK2_INSTALL_DIR`) |
| `--no-npm-install` | Skip `npm install` — hk2 then uses its regex-based parsers at runtime |
| `--preserve-data=off` | Legacy behavior: do **not** preserve user data on reinstall — the install dir is wiped |

Both `--prefix=value` and `--prefix value` forms are accepted; the same goes
for `--install-dir`.

```bash
./install.sh --prefix=$HOME/.local
./install.sh --prefix /usr/local          # same as default
HK2_INSTALL_DIR=~/.hk2-src ./install.sh   # keep the source copy out of the config home
./install.sh --no-npm-install             # skip Tree-sitter (regex fallback)
./install.sh --preserve-data=off          # legacy wipe: do NOT preserve user data on reinstall
```

### Optional PDF / Word parsing

`pdf-parse` (PDF) and `mammoth` (Word `.docx`) are optional dependencies —
the installer omits them to keep the base install light. To enable them:

```bash
cd ~/.hk2 && npm install                  # installs pdf-parse + mammoth
```

Legacy Office binaries (`.doc`, `.pptx`, `.ppt`) are extracted
dependency-free; only PDF and `.docx` need the optional packages.

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
(`HK2_INSTALL_DIR=~/.hk2-src ./install.sh`); uninstalling is then just:

```bash
rm -f /usr/local/bin/hk2
rm -rf ~/.hk2-src                         # the whole source copy, data untouched
```

To remove **everything**, including models, projects, sessions, and
knowledge bases: `rm -rf ~/.hk2` — back up what you want to keep first.

## Related documentation

- [Quick start](quick-start.md) — first project, first KB, first question
- [Configuration](../reference/configuration.md) — what lives inside `HK2_HOME`
- [Troubleshooting](../guides/troubleshooting.md) — Tree-sitter ABI issues and fallbacks
