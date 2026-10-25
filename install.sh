#!/usr/bin/env sh
# Installs the ppx command (Plastome Pixels' dev and release tool) on your PATH.
# Portable across Termux, Linux, macOS and WSL. No sudo.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/ppx"
[ -f "$SRC" ] || { echo "install: $SRC not found"; exit 1; }
sh -n "$SRC" || { echo "install: ppx has a syntax error"; exit 1; }

# the first writable bin folder, rather than assuming $PREFIX exists
for d in "${PREFIX:+$PREFIX/bin}" "$HOME/.local/bin" /usr/local/bin "$HOME/bin"; do
  [ -n "$d" ] || continue
  mkdir -p "$d" 2>/dev/null || continue
  [ -w "$d" ] || continue
  DEST="$d"; break
done
[ -n "${DEST:-}" ] || { echo "install: no writable bin folder found"; exit 1; }

cp "$SRC" "$DEST/ppx.new"
chmod +x "$DEST/ppx.new"
mv "$DEST/ppx.new" "$DEST/ppx"          # rename: safe while an older ppx runs

echo "installed ppx -> $DEST/ppx"
case "$HERE" in
  "$HOME/PlastomePixels") ;;
  *) echo "note: ppx expects the project in ~/PlastomePixels; elsewhere, set PPX_REPO=$HERE" ;;
esac
case ":$PATH:" in
  *":$DEST:"*) echo "next: ppx status" ;;
  *) echo "NOTE: $DEST is not on your PATH. Add it:"
     echo "  export PATH=\"$DEST:\$PATH\"" ;;
esac
