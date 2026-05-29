#!/bin/bash
# install-gh-fork-guard.sh — install gh-fork-guard wrapper to ~/.local/bin/gh.
#
# Run once per dev machine. Idempotent.
#
# Effect:
#   - Symlinks scripts/dev/gh-fork-guard.sh to ~/.local/bin/gh
#   - Ensures $HOME/.local/bin is on PATH (via ~/.zshrc or ~/.bashrc)
#
# After install, restart your shell or `source ~/.zshrc`.
# See ADR-0006 (isbtty/deshi/docs/adr/0006-gh-fork-guard.md) for rationale.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$SCRIPT_DIR/gh-fork-guard.sh"
TARGET="$HOME/.local/bin/gh"

if [ ! -f "$WRAPPER" ]; then
  echo "ERROR: $WRAPPER not found" >&2
  exit 1
fi
chmod +x "$WRAPPER"

mkdir -p "$HOME/.local/bin"

# ---- Install the wrapper symlink ----

if [ -L "$TARGET" ]; then
  EXISTING=$(readlink "$TARGET")
  if [ "$EXISTING" = "$WRAPPER" ]; then
    echo "✓ wrapper already installed: $TARGET → $WRAPPER"
  else
    echo "⚠ $TARGET symlinks to a different file ($EXISTING) — overwriting"
    ln -sf "$WRAPPER" "$TARGET"
    echo "✓ wrapper updated: $TARGET → $WRAPPER"
  fi
elif [ -e "$TARGET" ]; then
  echo "ERROR: $TARGET exists and is not a symlink. Move it aside, then re-run." >&2
  exit 1
else
  ln -s "$WRAPPER" "$TARGET"
  echo "✓ wrapper installed: $TARGET → $WRAPPER"
fi

# ---- Ensure PATH includes ~/.local/bin (first, so it shadows /opt/homebrew/bin/gh) ----

RC=""
SHELL_NAME=$(basename "${SHELL:-/bin/zsh}")
case "$SHELL_NAME" in
  zsh)  RC="$HOME/.zshrc" ;;
  bash) RC="$HOME/.bashrc" ;;
  *)
    # Fallback: try zsh then bash
    [ -f "$HOME/.zshrc" ] && RC="$HOME/.zshrc"
    [ -z "$RC" ] && [ -f "$HOME/.bashrc" ] && RC="$HOME/.bashrc"
    ;;
esac

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
GUARD_MARKER='# gh-fork-guard (isbtty/deshi)'

if [ -z "$RC" ]; then
  echo "⚠ Could not detect shell rc file. Add this to your shell startup manually:"
  echo "    $PATH_LINE"
elif grep -q "$GUARD_MARKER" "$RC" 2>/dev/null; then
  echo "✓ PATH entry already present in $RC"
else
  printf '\n%s\n%s\n' "$GUARD_MARKER" "$PATH_LINE" >> "$RC"
  echo "✓ PATH entry added to $RC"
fi

# ---- Final check: is the wrapper resolved first? ----

cat <<EOF

Installation done. Open a new terminal (or run \`source $RC\`) and verify with:

  which gh
  # Expected: $TARGET

  gh --version
  # Should still work normally (passthrough to real gh)

To disable the guard temporarily:

  GH_FORK_GUARD_DISABLE=1 gh ...

To uninstall:

  rm $TARGET
  # Then remove the PATH line from $RC

EOF
