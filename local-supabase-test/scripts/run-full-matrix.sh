#!/usr/bin/env bash
set -euo pipefail

# Run the full Phase 0 + Phase 1.5 deploy matrix with invoke after each cell.
#
# Usage:
#   ./scripts/run-full-matrix.sh
#
# One-liner equivalent:
#   ./scripts/run-full-matrix.sh
#
# Prerequisites: ./scripts/verify-setup.sh must pass (linked project, auth, env).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEPLOY="$ROOT_DIR/scripts/deploy-matrix.sh"
INVOKE="$ROOT_DIR/scripts/invoke-matrix.sh"
CELL=0
FAILED=0

run_cell() {
  local id="$1"
  local mode="$2"
  local scope="$3"
  local track="$4"
  CELL=$((CELL + 1))
  echo ""
  echo "========== [$id] ($CELL) deploy: $mode / $scope / $track =========="
  if ! "$DEPLOY" "$mode" "$scope" "$track"; then
    echo "FAIL deploy [$id]"
    FAILED=$((FAILED + 1))
    return 1
  fi
  echo "---------- [$id] invoke ----------"
  if [[ "$scope" == "single" ]]; then
    "$INVOKE" deploy-e2e-basic
  else
    "$INVOKE"
  fi
}

echo "=== Phase 0 — Track A (linked) ==="
for mode in default api docker; do
  for scope in single all; do
    run_cell "A-${mode}-${scope}" "$mode" "$scope" linked
  done
done

echo ""
echo "=== Phase 0 — Track B (explicit-ref) ==="
for mode in default api docker; do
  for scope in single all; do
    run_cell "B-${mode}-${scope}" "$mode" "$scope" explicit-ref
  done
done

echo ""
echo "=== Phase 1.5 — legacy-bundle ==="
run_cell "L1a" legacy single linked
run_cell "L1b" legacy all linked
run_cell "L2a" legacy single explicit-ref

echo ""
echo "========== Done: $CELL cells, $FAILED deploy failures =========="
if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
