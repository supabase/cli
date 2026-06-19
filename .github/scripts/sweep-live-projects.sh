#!/usr/bin/env bash
# Delete every staging project whose name starts with the given prefix (the live
# e2e job's per-run prefix). Shared by the in-run retry sweep (called best-effort
# with `|| true`) and the always() cleanup step (which propagates the exit code).
#
# Reads SUPABASE_ACCESS_TOKEN + CLI_E2E_API_URL from the environment. Exits
# non-zero if any DELETE failed; a failed *listing* also exits non-zero (pipefail).
set -o pipefail

PREFIX="${1:?usage: sweep-live-projects.sh PREFIX}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN required}"
: "${CLI_E2E_API_URL:?CLI_E2E_API_URL required}"

# Capture the list in a var (not a pipe-to-while subshell) so a failed delete is
# recorded in $failed; a failed listing aborts here via pipefail.
refs=$(curl -fsS -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  "${CLI_E2E_API_URL}/v1/projects" \
  | jq -r --arg p "$PREFIX" '.[] | select(.name|startswith($p)) | .ref // .id')

failed=0
for ref in $refs; do
  [ -n "$ref" ] || continue
  echo "deleting leftover project $ref"
  if ! curl -fsS -X DELETE -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
    "${CLI_E2E_API_URL}/v1/projects/${ref}" >/dev/null; then
    echo "::error::failed to delete leftover project $ref"
    failed=1
  fi
done
exit "$failed"
