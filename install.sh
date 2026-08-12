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
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --prefix) PREFIX="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#--install-dir=}" ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --no-npm-install) NO_NPM_INSTALL=1 ;;
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

if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR" ]; then
    echo "  (existing $INSTALL_DIR will be overwritten)"
    rm -rf "$INSTALL_DIR"
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  cp -R "$SCRIPT_DIR" "$INSTALL_DIR"
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
