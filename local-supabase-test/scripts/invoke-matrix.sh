#!/usr/bin/env bash
set -euo pipefail

# Invoke deployed Edge Functions and assert HTTP status + JSON shape.
#
# Usage:
#   ./scripts/invoke-matrix.sh [slug...]
#
# Environment:
#   SUPABASE_URL        e.g. https://<ref>.supabase.co
#   SUPABASE_ANON_KEY   project anon key
#
# Default: all slugs from scripts/functions.txt

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/functions.txt"

if [[ -f "$ROOT_DIR/.env.local" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env.local"
  SUPABASE_URL="${SUPABASE_URL//$'\r'/}"
  SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY//$'\r'/}"
fi

normalize_slug() {
  local value="$1"
  value="${value//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

if [[ -z "${SUPABASE_URL:-}" || -z "${SUPABASE_ANON_KEY:-}" ]]; then
  echo "SUPABASE_URL and SUPABASE_ANON_KEY must be set" >&2
  exit 1
fi

if [[ "$#" -gt 0 ]]; then
  SLUGS=("$@")
else
  SLUGS=()
  while IFS= read -r slug || [[ -n "$slug" ]]; do
    slug="$(normalize_slug "$slug")"
    [[ -z "$slug" ]] && continue
    SLUGS+=("$slug")
  done < "$MANIFEST"
fi

PASS=0
FAIL=0

invoke_slug() {
  local slug
  slug="$(normalize_slug "$1")"
  local url="${SUPABASE_URL%/}/functions/v1/${slug}"
  local expect_status expect_auth

  case "$slug" in
    deploy-e2e-no-jwt)
      expect_status=200
      expect_auth=none
      ;;
    deploy-e2e-jwt-required)
      expect_status=401
      expect_auth=none
      ;;
    *)
      expect_status=200
      expect_auth=bearer
      ;;
  esac

  local status body
  if [[ "$expect_auth" == "none" ]]; then
    status="$(curl -sS -o /tmp/invoke-body.json -w '%{http_code}' "$url")"
  else
    status="$(curl -sS -o /tmp/invoke-body.json -w '%{http_code}' \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" "$url")"
  fi
  body="$(cat /tmp/invoke-body.json)"

  local ok=false
  if [[ "$status" == "$expect_status" ]] && echo "$body" | grep -q "\"case\":\"${slug}\"" && echo "$body" | grep -q '"ok":true'; then
    ok=true
  fi

  if [[ "$slug" == "deploy-e2e-jwt-required" && "$expect_auth" == "none" && "$status" == "401" ]]; then
    # Retry with auth — informational only
    local authed_status
    authed_status="$(curl -sS -o /tmp/invoke-body-authed.json -w '%{http_code}' \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" "$url")"
    local authed_body
    authed_body="$(cat /tmp/invoke-body-authed.json)"
    if [[ "$authed_status" == "200" ]] && echo "$authed_body" | grep -q '"ok":true'; then
      ok=true
    fi
  fi

  if [[ "$ok" == "true" ]]; then
    echo "PASS  $slug  status=$status"
    PASS=$((PASS + 1))
  else
    echo "FAIL  $slug  status=$status  body=$body"
    FAIL=$((FAIL + 1))
  fi
}

for slug in "${SLUGS[@]}"; do
  slug="$(normalize_slug "$slug")"
  [[ -z "$slug" ]] && continue
  invoke_slug "$slug"
done

echo "---"
echo "Passed: $PASS  Failed: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
