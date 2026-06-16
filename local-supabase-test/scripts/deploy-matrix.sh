#!/usr/bin/env bash
set -euo pipefail

# Deploy matrix helper for functions deploy E2E manual testing.
#
# Usage:
#   ./scripts/deploy-matrix.sh <default|api|docker|legacy> <single|all> <linked|explicit-ref> [slug]
#
# Environment:
#   SUPABASE_PROJECT_REF  Required when using explicit-ref track
#   SUPABASE_CLI          Optional CLI binary (defaults to supabase on PATH)
#
# Examples:
#   ./scripts/deploy-matrix.sh default single linked
#   ./scripts/deploy-matrix.sh docker all explicit-ref
#   ./scripts/deploy-matrix.sh api single linked deploy-e2e-npm

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env.local ]]; then
  # shellcheck disable=SC1091
  source .env.local
  SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF//$'\r'/}"
  SUPABASE_CLI="${SUPABASE_CLI//$'\r'/}"
fi

MODE="${1:-}"
SCOPE="${2:-}"
REF_TRACK="${3:-}"
SLUG="${4:-deploy-e2e-basic}"

if [[ -z "$MODE" || -z "$SCOPE" || -z "$REF_TRACK" ]]; then
  echo "Usage: $0 <default|api|docker|legacy> <single|all> <linked|explicit-ref> [slug]" >&2
  exit 1
fi

CLI="${SUPABASE_CLI:-supabase}"
ARGS=(functions deploy)

case "$MODE" in
  default) ;;
  api) ARGS+=(--use-api) ;;
  docker) ARGS+=(--use-docker) ;;
  legacy) ARGS+=(--legacy-bundle) ;;
  *)
    echo "Unknown mode: $MODE (expected default|api|docker|legacy)" >&2
    exit 1
    ;;
esac

case "$SCOPE" in
  single) ARGS+=("$SLUG") ;;
  all) ;;
  *)
    echo "Unknown scope: $SCOPE (expected single|all)" >&2
    exit 1
    ;;
esac

case "$REF_TRACK" in
  linked) ;;
  explicit-ref)
    if [[ -z "${SUPABASE_PROJECT_REF:-}" ]]; then
      echo "SUPABASE_PROJECT_REF is required for explicit-ref track" >&2
      exit 1
    fi
    ARGS+=(--project-ref "$SUPABASE_PROJECT_REF")
    ;;
  *)
    echo "Unknown ref track: $REF_TRACK (expected linked|explicit-ref)" >&2
    exit 1
    ;;
esac

echo "+ $CLI ${ARGS[*]}"
exec "$CLI" "${ARGS[@]}"
