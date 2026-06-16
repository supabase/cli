#!/usr/bin/env bash
set -euo pipefail

# Checks prerequisites before running DEPLOY-E2E.md matrix.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OK=0
WARN=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  case "$result" in
    ok) echo "OK   $label"; OK=$((OK + 1)) ;;
    warn) echo "WARN $label"; WARN=$((WARN + 1)) ;;
    *) echo "FAIL $label"; FAIL=$((FAIL + 1)) ;;
  esac
}

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  source .env.local
  # Strip CRLF from values sourced on Windows-edited files
  SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF//$'\r'/}"
  SUPABASE_URL="${SUPABASE_URL//$'\r'/}"
  SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY//$'\r'/}"
  SUPABASE_CLI="${SUPABASE_CLI//$'\r'/}"
  check ".env.local present" ok
else
  check ".env.local present (copy from .env.local.example)" warn
fi

CLI="${SUPABASE_CLI:-supabase}"

if [[ -x "$CLI" ]] || command -v "$CLI" >/dev/null 2>&1; then
  check "supabase CLI available ($CLI)" ok
else
  check "supabase CLI available (set SUPABASE_CLI or install supabase)" fail
fi

if "$CLI" functions deploy --help >/dev/null 2>&1; then
  check "functions deploy command available" ok
else
  check "functions deploy command available" fail
fi

if [[ -n "${SUPABASE_PROJECT_REF:-}" ]]; then
  check "SUPABASE_PROJECT_REF set" ok
else
  check "SUPABASE_PROJECT_REF set" warn
fi

if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_ANON_KEY:-}" ]]; then
  check "SUPABASE_URL + SUPABASE_ANON_KEY set" ok
else
  check "SUPABASE_URL + SUPABASE_ANON_KEY set (needed for invoke-matrix.sh)" warn
fi

if docker info >/dev/null 2>&1; then
  check "Docker running" ok
else
  check "Docker running (needed for --use-docker / --legacy-bundle)" warn
fi

# Auth check — avoid hanging on slow legacy CLI startup / API calls
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  check "supabase authenticated (SUPABASE_ACCESS_TOKEN)" ok
else
  ("$CLI" projects list >/dev/null 2>&1) &
  AUTH_PID=$!
  AUTH_WAIT=0
  while kill -0 "$AUTH_PID" 2>/dev/null && [[ "$AUTH_WAIT" -lt 10 ]]; do
    sleep 1
    AUTH_WAIT=$((AUTH_WAIT + 1))
  done
  if kill -0 "$AUTH_PID" 2>/dev/null; then
    kill "$AUTH_PID" 2>/dev/null || true
    wait "$AUTH_PID" 2>/dev/null || true
    check "supabase authenticated ($CLI projects list timed out — run: $CLI login)" warn
  elif wait "$AUTH_PID"; then
    check "supabase authenticated" ok
  else
    check "supabase authenticated (run: $CLI login)" fail
  fi
fi

# Linked project check (local file — avoids slow/hanging `functions list` API call)
PROJECT_REF_FILE="$ROOT_DIR/supabase/.temp/project-ref"
if [[ -f "$PROJECT_REF_FILE" ]]; then
  LINKED_REF="$(tr -d '[:space:]' < "$PROJECT_REF_FILE")"
  if [[ -n "${SUPABASE_PROJECT_REF:-}" && "$LINKED_REF" != "$SUPABASE_PROJECT_REF" ]]; then
    check "project linked (ref $LINKED_REF != SUPABASE_PROJECT_REF=$SUPABASE_PROJECT_REF)" warn
  else
    check "project linked in this directory (ref: $LINKED_REF)" ok
  fi
else
  REF_HINT="${SUPABASE_PROJECT_REF:-YOUR_REF}"
  check "project linked in this directory (run: $CLI link --project-ref $REF_HINT)" fail
fi

FUNC_COUNT="$(find supabase/functions -name index.ts -o -name handler.ts | wc -l | tr -d ' ')"
check "${FUNC_COUNT} function entrypoints on disk" ok

echo "---"
echo "Ready checks: $OK ok, $WARN warnings, $FAIL failures"

if [[ "$FAIL" -gt 0 ]]; then
  echo "Fix failures above, then run DEPLOY-E2E.md Phase 0."
  exit 1
fi

if [[ "$WARN" -gt 0 ]]; then
  echo "Warnings present — some matrix phases may be skipped until resolved."
fi

echo "Setup looks good. Start with: ./scripts/deploy-matrix.sh default single linked"
