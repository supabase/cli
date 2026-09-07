#!/usr/bin/env bash
# Trusted wrapper around the PR CLI. Injects the staging token into the child
# process only — Codex's own environment must not contain SUPABASE_ACCESS_TOKEN.
set -euo pipefail

: "${DOGFOOD_CLI_MAIN:?DOGFOOD_CLI_MAIN is required}"

if [[ -n "${DOGFOOD_TOKEN_FILE:-}" && -f "${DOGFOOD_TOKEN_FILE}" ]]; then
  SUPABASE_ACCESS_TOKEN="$(tr -d '[:space:]' < "${DOGFOOD_TOKEN_FILE}")"
  export SUPABASE_ACCESS_TOKEN
fi

export SUPABASE_PROFILE="${SUPABASE_PROFILE:-supabase-staging}"

exec bun --no-config "${DOGFOOD_CLI_MAIN}" --profile supabase-staging "$@"
