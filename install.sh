#!/bin/sh
# install.sh — install hk2 as a global command.
#
# Usage:
#   ./install.sh                     # install to /usr/local/bin/hk2 (default)
#   ./install.sh --prefix=$HOME/.local
#   curl -fsSL https://your-host/install.sh | sh
#
# Behavior:
#   - Clones/copies the project to $HK2_INSTALL_DIR (default: ~/.hk2)
#     If the script is run from inside the repo, it uses the current dir.
#   - USER DATA IS PRESERVED across reinstalls: models.json / projects.json /
#     theme.json / kb/ / sessions/ / logs/ living in the install dir are moved
#     aside, the code tree is refreshed, then moved back. Disable with
#     --preserve-data=off (the pre-fix rm -rf behavior).
#   - Symlinks $PREFIX/bin/hk2 to ./bin/hk2
#   - Prints install location + PATH hint
#
# Requires sh + node >= 18 in PATH. Runs `npm install --omit=optional`
# after copy to build Tree-sitter native bindings. Pass --no-npm-install
# to skip (then hk2 falls back to the regex-based parsers).

set -e

PREFIX="${HK2_PREFIX:-/usr/local}"
INSTALL_DIR="${HK2_INSTALL_DIR:-$HOME/.hk2}"
SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# Parse arguments. Supports both --prefix=value and --prefix value forms.
NO_NPM_INSTALL=0
PRESERVE_DATA=1
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --prefix) PREFIX="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#--install-dir=}" ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --no-npm-install) NO_NPM_INSTALL=1 ;;
    --preserve-data=off) PRESERVE_DATA=0 ;;
    *) ;;
  esac
  shift
done

if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/bin/hk2" ]; then
  echo "install.sh: cannot locate the hk2 source tree." >&2
  echo "Run this script from inside the hk2 repo, or set HK2_INSTALL_DIR to a clone path." >&2
  exit 1
fi

echo "Installing hk2 from $SCRIPT_DIR"
echo "  install dir: $INSTALL_DIR"
echo "  bin prefix:  $PREFIX/bin"

# Paths inside the install dir that hold USER DATA, not install artifacts.
# lib/config/home.js (HK2_HOME) + lib/agent/tool_theme.js (THEME_PATH) define
# this set: models.json, projects.json, kb/, sessions/, logs/, theme.json.
# install.sh and the code it ships must treat this list as a contract.
DATA_ITEMS="models.json projects.json theme.json kb sessions logs"

if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  # Stale preserved data from an interrupted earlier run must never survive
  # into a new one: a leftover $INSTALL_DIR.hk2-preserve would otherwise be
  # clobbered below while the user believes their data was saved.
  rm -rf "${INSTALL_DIR}.hk2-preserve"

  PRESERVE_DIR=""
  if [ "$PRESERVE_DATA" -eq 1 ] && [ -d "$INSTALL_DIR" ]; then
    for item in $DATA_ITEMS; do
      if [ -e "$INSTALL_DIR/$item" ]; then
        PRESERVE_DIR="${INSTALL_DIR}.hk2-preserve"
        break
      fi
    done
  fi

  if [ -n "$PRESERVE_DIR" ]; then
    echo "  (preserving user data: $DATA_ITEMS found in $INSTALL_DIR)"
    mkdir -p "$PRESERVE_DIR"
    for item in $DATA_ITEMS; do
      [ -e "$INSTALL_DIR/$item" ] && mv "$INSTALL_DIR/$item" "$PRESERVE_DIR/"
    done
  elif [ -d "$INSTALL_DIR" ]; then
    echo "  (existing $INSTALL_DIR will be overwritten)"
  fi

  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  cp -R "$SCRIPT_DIR" "$INSTALL_DIR"
  # Don't ship dev-only state inside the installed copy.
  rm -rf "$INSTALL_DIR/.git" "$INSTALL_DIR/node_modules"

  if [ -n "$PRESERVE_DIR" ]; then
    # Restore user data on top of the fresh copy. If the new tree ships a same-
    # named item (e.g. a future version adds a kb/ template), user data wins —
    # this is an upgrade, not a factory reset.
    for item in $DATA_ITEMS; do
      if [ -e "$PRESERVE_DIR/$item" ]; then
        rm -rf "$INSTALL_DIR/$item"
        mv "$PRESERVE_DIR/$item" "$INSTALL_DIR/"
      fi
    done
    rmdir "$PRESERVE_DIR" 2>/dev/null || true
  fi
fi

mkdir -p "$PREFIX/bin"
ln -sf "$INSTALL_DIR/bin/hk2" "$PREFIX/bin/hk2"

# Install npm dependencies (Tree-sitter native bindings).
# Skipped with --no-npm-install or when npm isn't on PATH; in that case
# hk2 falls back to its regex-based parsers at runtime.
if [ "$NO_NPM_INSTALL" -eq 0 ] && command -v npm >/dev/null 2>&1; then
  echo ""
  echo "Installing npm dependencies (Tree-sitter grammars)..."
  # --omit=optional: pdf-parse / mammoth are opt-in (PDF/Word parsing)
  (cd "$INSTALL_DIR" && npm install --omit=optional --no-audit --no-fund) \
    || echo "Warning: npm install failed. hk2 will fall back to regex parsers." >&2
else
  echo ""
  echo "Skipping npm install (pass without --no-npm-install, or run 'npm install' manually)."
  echo "hk2 will use the regex-based parsers; AST precision will be reduced."
fi

# Verify
if command -v node >/dev/null 2>&1; then
  echo ""
  echo "Verifying:"
  "$PREFIX/bin/hk2" --help | head -3
else
  echo ""
  echo "Warning: node not found in PATH. Install Node.js >= 18 before running hk2." >&2
fi

echo ""
echo "Done. hk2 is installed at: $PREFIX/bin/hk2"

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *)
    echo "Add $PREFIX/bin to your PATH:"
    echo "  export PATH=\"$PREFIX/bin:\$PATH\""
    ;;
esac
