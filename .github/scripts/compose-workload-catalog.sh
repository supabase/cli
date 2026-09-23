#!/usr/bin/env bash
# Rebuilds the workload catalog as BASE_SHA + the pins pending on SYNC_BRANCH +
# this dispatch's pin (SLIM_SERVICE/SLIM_VERSION/SLIM_DIGEST). Prints the
# SYNC_BRANCH head it read, empty when the branch does not exist, so the push
# can lease against it. Needs full history for the merge base.
set -euo pipefail

: "${BASE_SHA:?}" "${SYNC_BRANCH:?}"
catalog=packages/stack/src/Artifacts.ts

git checkout "$BASE_SHA" -- "$catalog"

head=$(git ls-remote --heads origin "refs/heads/$SYNC_BRANCH" | cut -f1)
if [ -n "$head" ]; then
  git fetch --quiet --no-tags origin "$head" >&2
  merge_base=$(git merge-base "$BASE_SHA" "$head")
  scratch=$(mktemp -d)
  git show "$merge_base:$catalog" > "$scratch/merge-base.ts"
  git show "$head:$catalog" > "$scratch/branch.ts"
  bun .github/scripts/sync-workload-catalog.ts carry "$scratch/merge-base.ts" "$scratch/branch.ts" >&2
fi

bun .github/scripts/sync-workload-catalog.ts >&2
pnpm exec oxfmt --config .oxfmtrc.json "$catalog" >&2

printf '%s\n' "$head"
