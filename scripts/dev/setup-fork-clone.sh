#!/bin/bash
# setup-fork-clone.sh — pin `gh` default repo to this clone's `origin` (= the fork).
#
# Run once per fork clone (e.g. just after `git clone`). Idempotent.
#
# What this does:
#   - Reads `origin` remote URL
#   - Parses it into <owner>/<repo>
#   - Runs `gh repo set-default <owner>/<repo>`, which stores
#     `remote.origin.gh-resolved = base` in .git/config
#   - After this, `gh pr create` / `gh issue create` etc. target this fork by
#     default — no need to pass `--repo` every time.
#
# See ADR-0006 in isbtty/deshi/docs/adr/ for rationale.

set -e

# Defensive: skip silently in contexts where this is not applicable.
# This script is intended to be safe to call from other setup scripts
# (e.g. daemon/bin/setup-cli.sh).
if ! command -v gh >/dev/null 2>&1; then
  echo "(setup-fork-clone: gh CLI not installed, skipping)" >&2
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "(setup-fork-clone: not inside a git repo, skipping)" >&2
  exit 0
fi

cd "$(git rev-parse --show-toplevel)"

ORIGIN_URL=$(git remote get-url origin 2>/dev/null) || {
  echo "(setup-fork-clone: 'origin' remote not configured, skipping)" >&2
  exit 0
}

if [[ "$ORIGIN_URL" != *"github.com"* ]]; then
  echo "(setup-fork-clone: origin is not on github.com, skipping)" >&2
  exit 0
fi

REPO=$(echo "$ORIGIN_URL" | sed 's|.*github.com[:/]||; s|\.git$||')

if [[ ! "$REPO" =~ ^[^/]+/[^/]+$ ]]; then
  echo "(setup-fork-clone: could not parse <owner>/<repo> from $ORIGIN_URL, skipping)" >&2
  exit 0
fi

echo "Pinning gh default for this clone:"
echo "  origin URL : $ORIGIN_URL"
echo "  target repo: $REPO"
echo ""

gh repo set-default "$REPO"

# Verify
DEFAULT=$(gh repo set-default --view 2>&1 | head -1)
if [ "$DEFAULT" = "$REPO" ]; then
  echo "✓ gh default repo: $DEFAULT"
else
  echo "⚠ expected '$REPO' but gh reports '$DEFAULT'" >&2
  exit 1
fi

# Show remotes for awareness
echo ""
echo "Current remotes:"
git remote -v | sed 's/^/  /'

echo ""
echo "✓ Setup done. \`gh pr create\` / \`gh issue create\` in this clone will now"
echo "  target $REPO by default."
