#!/bin/bash
# gh-fork-guard.sh — gh CLI wrapper that blocks accidental cross-fork operations.
#
# Background: clones with both `origin` (fork) and `upstream` (public OSS) remotes
# are at risk of accidentally posting PRs/issues to upstream because `gh` defaults
# to the parent repo for fork-detected clones when --repo is omitted. See
# ADR-0006 for the full incident analysis.
#
# Installed by: scripts/dev/install-gh-fork-guard.sh
#   → symlinks this script to ~/.local/bin/gh
#   → ~/.local/bin is placed first in PATH so this wrapper intercepts all gh calls.
#
# Block conditions (all must hold):
#   1. Current directory is inside a git repo
#   2. The repo has both `origin` AND `upstream` remotes (= fork clone)
#   3. Subcommand is in the write-set (pr create / issue create / release create / ...)
#   4. Invocation lacks `--repo` (or `-R`) flag
#   5. `git config remote.origin.gh-resolved` is not set to `base`
#      (= setup-fork-clone.sh has not been run for this clone)
#
# Bypass: GH_FORK_GUARD_DISABLE=1 gh <subcmd> ...  (use when you really mean upstream)

set -e

# ---- Locate the real gh binary (excluding ourselves) ----

SELF="${BASH_SOURCE[0]}"
SELF_RESOLVED=$(readlink -f "$SELF" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$SELF" 2>/dev/null || echo "$SELF")

REAL_GH=""
IFS=':' read -ra PATH_PARTS <<< "$PATH"
for p in "${PATH_PARTS[@]}"; do
  candidate="$p/gh"
  if [ -x "$candidate" ]; then
    candidate_resolved=$(readlink -f "$candidate" 2>/dev/null || python3 -c "import os,sys;print(os.path.realpath(sys.argv[1]))" "$candidate" 2>/dev/null || echo "$candidate")
    if [ "$candidate_resolved" != "$SELF_RESOLVED" ]; then
      REAL_GH="$candidate"
      break
    fi
  fi
done

if [ -z "$REAL_GH" ]; then
  echo "gh-fork-guard: could not locate real gh binary in PATH" >&2
  echo "  Tried: $PATH" >&2
  exit 127
fi

# ---- Bypass conditions: passthrough to real gh immediately ----

# Explicit bypass via env var
if [ -n "$GH_FORK_GUARD_DISABLE" ]; then
  exec "$REAL_GH" "$@"
fi

# Not in a git repo
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exec "$REAL_GH" "$@"
fi

# No 'upstream' remote (= not a fork clone of the at-risk shape)
if ! git remote 2>/dev/null | grep -qx 'upstream'; then
  exec "$REAL_GH" "$@"
fi

# --repo / -R explicitly passed (user is targeting deliberately)
for arg in "$@"; do
  case "$arg" in
    --repo|--repo=*|-R)
      exec "$REAL_GH" "$@"
      ;;
  esac
done

# gh-resolved is configured (= setup-fork-clone.sh has been run)
RESOLVED=$(git config --get remote.origin.gh-resolved 2>/dev/null || true)
if [ "$RESOLVED" = "base" ]; then
  exec "$REAL_GH" "$@"
fi

# ---- Block conditions: check if subcommand is in the write-set ----

SUBCMD="${1:-} ${2:-}"
case "$SUBCMD" in
  "pr create"|"pr edit"|"pr comment"|"pr review"|"pr merge"|"pr close"|"pr reopen"|"pr ready"|\
  "issue create"|"issue edit"|"issue comment"|"issue close"|"issue reopen"|"issue delete"|"issue transfer"|\
  "release create"|"release edit"|"release delete"|"release upload"|\
  "workflow run"|"workflow enable"|"workflow disable"|\
  "repo edit"|"repo delete"|"repo rename"|"repo archive"|"repo unarchive"|\
  "label create"|"label edit"|"label delete"|"label clone"|\
  "secret set"|"secret delete"|"variable set"|"variable delete"|\
  "ssh-key add"|"ssh-key delete"|"gpg-key add"|"gpg-key delete"|\
  "deploy-key add"|"deploy-key delete")
    UPSTREAM_URL=$(git remote get-url upstream 2>/dev/null || echo "<unknown>")
    ORIGIN_URL=$(git remote get-url origin 2>/dev/null || echo "<unknown>")
    REPO_GUESS=$(echo "$ORIGIN_URL" | sed 's|.*github.com[:/]||; s|\.git$||')
    cat >&2 <<EOF

⛔ gh-fork-guard: \`gh $SUBCMD\` blocked

  This clone has both 'origin' and 'upstream' remotes:
    origin   = $ORIGIN_URL
    upstream = $UPSTREAM_URL

  Without an explicit --repo flag, \`gh\` may target upstream by accident
  (see ADR-0006 in isbtty/deshi).

  To proceed, choose one:

    [A] Recommended (once per clone, then forget about this guard):
        gh repo set-default $REPO_GUESS
        # or run: bash <deshi-clone>/scripts/dev/setup-fork-clone.sh

    [B] One-shot: pass --repo explicitly
        gh $SUBCMD --repo <owner>/<repo> ...

    [C] Bypass: when you really mean upstream (sparingly!)
        GH_FORK_GUARD_DISABLE=1 gh $SUBCMD ...

EOF
    exit 1
    ;;
esac

# Default: passthrough to real gh
exec "$REAL_GH" "$@"
