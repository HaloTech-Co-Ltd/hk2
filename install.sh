#!/bin/sh
# install.sh — install hk2 as a global command.
#
# Usage:
#   ./install.sh                     # install to /usr/local/bin/hk2 (default)
#   ./install.sh --prefix=$HOME/.local
#
# Behavior:
#   - Clones/copies the project to $HK2_INSTALL_DIR (default: ~/.hk2)
#     If the script is run from inside the repo, it uses the current dir.
#   - USER DATA IS PRESERVED across reinstalls according to
#     config/install-data-items.txt. The upgrade uses recoverable sibling
#     staging/backup directories and resumes an interrupted transaction.
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
CONFIRM_DATA_LOSS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --prefix) PREFIX="$2"; shift ;;
    --install-dir=*) INSTALL_DIR="${1#--install-dir=}" ;;
    --install-dir) INSTALL_DIR="$2"; shift ;;
    --no-npm-install) NO_NPM_INSTALL=1 ;;
    --preserve-data=off) PRESERVE_DATA=0 ;;
    --confirm-data-loss) CONFIRM_DATA_LOSS=1 ;;
    *) ;;
  esac
  shift
done

if ! command -v node >/dev/null 2>&1; then
  echo "install.sh: node >= 18 is required." >&2
  exit 1
fi

if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/bin/hk2" ]; then
  echo "install.sh: cannot locate the hk2 source tree." >&2
  echo "Run this script from inside the hk2 repo, or set HK2_INSTALL_DIR to a clone path." >&2
  exit 1
fi

DATA_MANIFEST="$SCRIPT_DIR/config/install-data-items.txt"
if [ ! -f "$DATA_MANIFEST" ]; then
  echo "install.sh: missing persistent-data manifest: $DATA_MANIFEST" >&2
  exit 1
fi

# Normalize before any destructive operation, then reject targets whose typo
# could erase a home/source tree (or recurse while copying the source).
[ -n "$INSTALL_DIR" ] || { echo "install.sh: --install-dir must not be empty" >&2; exit 1; }
INSTALL_DIR="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "$INSTALL_DIR")"
HOME_DIR="$(node -e 'console.log(require("path").resolve(process.argv[1]))' "$HOME")"
case "$INSTALL_DIR" in
  /|"$HOME_DIR")
    echo "install.sh: refusing dangerous --install-dir: $INSTALL_DIR" >&2
    exit 1 ;;
  "$SCRIPT_DIR"/*)
    echo "install.sh: --install-dir must not be inside the source tree: $INSTALL_DIR" >&2
    exit 1 ;;
esac
case "$HOME_DIR" in
  "$INSTALL_DIR"/*) echo "install.sh: refusing --install-dir that contains HOME: $INSTALL_DIR" >&2; exit 1 ;;
esac
case "$SCRIPT_DIR" in
  "$INSTALL_DIR"/*) echo "install.sh: refusing --install-dir that contains the source tree: $INSTALL_DIR" >&2; exit 1 ;;
esac

if [ "$PRESERVE_DATA" -eq 0 ] && [ "$CONFIRM_DATA_LOSS" -ne 1 ]; then
  echo "install.sh: --preserve-data=off destroys existing user data; repeat with --confirm-data-loss." >&2
  exit 1
fi

echo "Installing hk2 from $SCRIPT_DIR"
echo "  install dir: $INSTALL_DIR"
echo "  bin prefix:  $PREFIX/bin"

# Convert the checked-in, testable manifest to a shell word list. Entries are
# deliberately restricted to safe top-level names.
DATA_ITEMS="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$DATA_MANIFEST")"
for item in $DATA_ITEMS; do
  case "$item" in
    */*|.*|*..*) echo "install.sh: unsafe data manifest entry: $item" >&2; exit 1 ;;
  esac
done

if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  PRESERVE_DIR="${INSTALL_DIR}.hk2-preserve"
  OLD_DIR="${INSTALL_DIR}.hk2-old"
  STAGE_DIR="${INSTALL_DIR}.hk2-stage.$$"
  TX_MANIFEST="$PRESERVE_DIR/.manifest"
  trap 'rm -rf "$STAGE_DIR"' EXIT HUP INT TERM

  # Resume an interrupted transaction before starting another. A legacy
  # preserve directory may have no .manifest; infer it without deleting data.
  if [ -d "$PRESERVE_DIR" ]; then
    echo "  (recovering preserved user data from $PRESERVE_DIR)"
    [ -f "$TX_MANIFEST" ] || : > "$TX_MANIFEST"
    for item in $DATA_ITEMS; do
      if [ -e "$PRESERVE_DIR/$item" ] && ! grep -Fx "$item" "$TX_MANIFEST" >/dev/null 2>&1; then
        echo "$item" >> "$TX_MANIFEST"
      fi
    done
    if [ ! -d "$INSTALL_DIR" ] && [ -d "$OLD_DIR" ]; then mv "$OLD_DIR" "$INSTALL_DIR"; fi
    if [ -d "$INSTALL_DIR" ]; then
      for item in $DATA_ITEMS; do
        if [ -e "$PRESERVE_DIR/$item" ]; then
          rm -rf "$INSTALL_DIR/$item"
          mv "$PRESERVE_DIR/$item" "$INSTALL_DIR/"
        fi
      done
      RECOVERY_OK=1
      while IFS= read -r item; do [ -z "$item" ] || [ -e "$INSTALL_DIR/$item" ] || RECOVERY_OK=0; done < "$TX_MANIFEST"
      if [ "$RECOVERY_OK" -eq 1 ]; then
        rm -rf "$PRESERVE_DIR"
        [ -d "$OLD_DIR" ] && rm -rf "$OLD_DIR"
      fi
    fi
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -R "$SCRIPT_DIR"/. "$STAGE_DIR/"
  # Don't ship dev-only state inside the installed copy.
  rm -rf "$STAGE_DIR/.git" "$STAGE_DIR/node_modules"
  [ "${HK2_INSTALL_TEST_FAIL_AT:-}" = "after-stage-copy" ] && exit 97

  if [ "$PRESERVE_DATA" -eq 1 ]; then
    mkdir -p "$PRESERVE_DIR"
    : > "$TX_MANIFEST"
    for item in $DATA_ITEMS; do
      if [ -e "$INSTALL_DIR/$item" ]; then
        echo "$item" >> "$TX_MANIFEST"
        mv "$INSTALL_DIR/$item" "$PRESERVE_DIR/"
      fi
    done
    [ "${HK2_INSTALL_TEST_FAIL_AT:-}" = "after-data-move" ] && exit 97
  fi

  [ -d "$OLD_DIR" ] && rm -rf "$OLD_DIR"
  if [ -d "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$OLD_DIR"; fi
  [ "${HK2_INSTALL_TEST_FAIL_AT:-}" = "after-old-tree-move" ] && exit 97
  mv "$STAGE_DIR" "$INSTALL_DIR"
  [ "${HK2_INSTALL_TEST_FAIL_AT:-}" = "after-new-tree-move" ] && exit 97

  if [ "$PRESERVE_DATA" -eq 1 ] && [ -d "$PRESERVE_DIR" ]; then
    RESTORED=0
    for item in $DATA_ITEMS; do
      if [ -e "$PRESERVE_DIR/$item" ]; then
        rm -rf "$INSTALL_DIR/$item"
        mv "$PRESERVE_DIR/$item" "$INSTALL_DIR/"
        RESTORED=$((RESTORED + 1))
        [ "${HK2_INSTALL_TEST_FAIL_AT:-}" = "during-data-restore" ] && [ "$RESTORED" -eq 1 ] && exit 97
      fi
    done
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
  VERIFY_OUTPUT="$("$PREFIX/bin/hk2" --help)"
  printf '%s\n' "$VERIFY_OUTPUT" | sed -n '1,3p'
else
  echo ""
  echo "Warning: node not found in PATH. Install Node.js >= 18 before running hk2." >&2
fi

# Commit the transaction only after copy/dependency/command verification.
if [ "${SCRIPT_DIR:-}" != "${INSTALL_DIR:-}" ] && [ -n "${PRESERVE_DIR:-}" ]; then
  RESTORE_OK=1
  if [ -f "$TX_MANIFEST" ]; then
    while IFS= read -r item; do [ -z "$item" ] || [ -e "$INSTALL_DIR/$item" ] || RESTORE_OK=0; done < "$TX_MANIFEST"
  fi
  if [ "$RESTORE_OK" -ne 1 ]; then
    echo "install.sh: preserved data verification failed; backup retained at $PRESERVE_DIR" >&2
    exit 1
  fi
  rm -rf "$PRESERVE_DIR"
  [ -d "$OLD_DIR" ] && rm -rf "$OLD_DIR"
  trap - EXIT HUP INT TERM
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
