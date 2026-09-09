#!/usr/bin/env bash
# Trusted wrapper around the PR CLI. Injects the staging token into the child
# process only — Codex's own environment must not contain SUPABASE_ACCESS_TOKEN.
set -euo pipefail

: "${DOGFOOD_CLI_MAIN:?DOGFOOD_CLI_MAIN is required}"

TOKEN_FILE="${DOGFOOD_TOKEN_FILE:-${RUNNER_TEMP:?}/dogfood.token}"
if [[ ! -f "${TOKEN_FILE}" ]]; then
  echo "sb: missing token file ${TOKEN_FILE}" >&2
  exit 1
fi
SUPABASE_ACCESS_TOKEN="$(tr -d '[:space:]' < "${TOKEN_FILE}")"
if [[ -z "${SUPABASE_ACCESS_TOKEN}" ]]; then
  echo "sb: token file ${TOKEN_FILE} is empty" >&2
  exit 1
fi
export SUPABASE_ACCESS_TOKEN

PREFIX_FILE="${DOGFOOD_PROJECT_PREFIX_FILE:-/tmp/ai-dogfood/project-prefix.txt}"
if [[ "${1:-}" == "projects" && "${2:-}" == "create" ]]; then
  if [[ ! -f "${PREFIX_FILE}" ]]; then
    echo "sb: missing project prefix file ${PREFIX_FILE}" >&2
    exit 1
  fi
  prefix="$(tr -d '[:space:]' < "${PREFIX_FILE}")"
  if [[ -z "${prefix}" ]]; then
    echo "sb: project prefix file ${PREFIX_FILE} is empty" >&2
    exit 1
  fi
  # Positional name only — a flag value like --db-password must not satisfy this.
  skip_next=0
  name=""
  for arg in "${@:3}"; do
    if [[ "${skip_next}" -eq 1 ]]; then
      skip_next=0
      continue
    fi
    case "${arg}" in
      --org-id|--db-password|--region|--size|--release-channel|--postgres-engine|--plan)
        skip_next=1
        continue
        ;;
      --*|-*|--)
        continue
        ;;
    esac
    name="${arg}"
    break
  done
  if [[ -z "${name}" || "${name}" != "${prefix}"* ]]; then
    echo "sb: projects create name must start with ${prefix}" >&2
    exit 1
  fi
fi

export SUPABASE_PROFILE="${SUPABASE_PROFILE:-supabase-staging}"

exec bun --no-config "${DOGFOOD_CLI_MAIN}" --profile supabase-staging "$@"
