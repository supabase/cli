#!/usr/bin/env bash
# Delete every staging project whose name starts with the given prefix (the live
# e2e job's per-run prefix). Runs as the live e2e job's always() cleanup step,
# which propagates the exit code.
#
# Reads SUPABASE_ACCESS_TOKEN + SUPABASE_LIVE_API_URL from the environment. Exits
# non-zero if any DELETE failed; a failed *listing* also exits non-zero.
set -eo pipefail

PREFIX="${1:?usage: sweep-live-projects.sh PREFIX}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN required}"
: "${SUPABASE_LIVE_API_URL:?SUPABASE_LIVE_API_URL required}"

# Retry into a file, not a pipe: curl rewinds a file between attempts, but a
# pipe keeps an already-flushed body and the retry would duplicate the listing.
listing=$(mktemp)
trap 'rm -f "$listing"' EXIT
curl -fsS --retry 3 --retry-connrefused --max-time 60 --retry-max-time 120 \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -o "$listing" "${SUPABASE_LIVE_API_URL}/v1/projects"
# Capture the list in a var (not a pipe-to-while subshell) so a failed delete is
# recorded in $failed; a failed listing aborts above via errexit.
projects=$(jq -r --arg p "$PREFIX" '.[] | select(.name|startswith($p)) | "\(.ref // .id) \(.status)"' "$listing")

failed=0
while read -r ref status; do
  [ -n "$ref" ] || continue
  # Already deleted by the suite; a second DELETE is refused.
  case "$status" in
    GOING_DOWN | REMOVED)
      echo "skipping project $ref ($status)"
      continue
      ;;
  esac
  echo "deleting leftover project $ref"
  if ! curl -fsS -X DELETE -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "${SUPABASE_LIVE_API_URL}/v1/projects/${ref}" >/dev/null; then
    echo "::error::failed to delete leftover project $ref"
    failed=1
  fi
done <<< "$projects"
exit "$failed"
