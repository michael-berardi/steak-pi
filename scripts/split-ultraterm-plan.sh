#!/bin/bash
set -euo pipefail

# Prints (and with --run, executes) the `git subtree split` that exports
# packages/ultraterm-plan as its own branch, ready to become the standalone
# ultraterm-plan repository. Local only: this never pushes, tags, or publishes.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="packages/ultraterm-plan"
BRANCH="ultraterm-plan-export"

CMD=(git subtree split --prefix "$PREFIX" -b "$BRANCH")

if [[ "${1:-}" == "--run" ]]; then
  cd "$ROOT"
  echo "Splitting $PREFIX into local branch $BRANCH (no push)…"
  "${CMD[@]}"
  echo "Done. Inspect with: git log \"$BRANCH\" — then push it as the new"
  echo "repository's main when you are satisfied. Nothing was pushed."
else
  (cd "$ROOT" && printf '%q ' "${CMD[@]}"; echo)
  echo "(add --run to execute; the split is local and never pushes)"
fi
