#!/usr/bin/env bash
# Delete every staging project whose name starts with the live e2e prefix.
set -eo pipefail

PREFIX="${1:?usage: sweep-live-projects.sh PREFIX}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN required}"
: "${SUPABASE_LIVE_API_URL:?SUPABASE_LIVE_API_URL required}"

listing=$(mktemp)
headers=$(mktemp)
response=$(mktemp)
trap 'rm -f "$listing" "$headers" "$response"' EXIT

api_request() {
  local method=$1 url=$2 output=$3
  : > "$headers"
  : > "$output"
  API_CODE=$(curl -sS --max-time 15 -X "$method" -D "$headers" -o "$output" \
    -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" -w '%{http_code}' "$url") || API_CODE=000
  API_REQUEST_ID=$(awk 'tolower($0) ~ /^x-request-id:/ { sub(/^[^:]*:[[:space:]]*/, ""); gsub(/[[:space:]]+$/, ""); print; exit }' "$headers" | tr -cd '[:alnum:]_.:/-' | cut -c1-120)
}

fetch_listing_once() {
  api_request GET "${SUPABASE_LIVE_API_URL}/v1/projects" "$listing"
  if [ "$API_CODE" != 200 ]; then
    echo "project listing failed (HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2
    case "$API_CODE" in 000|408|429|5??) return 1 ;; esac
    return 2
  fi
  if ! jq -e 'type == "array" and all(.[]; (.name | type == "string") and ((.ref // .id) | type == "string") and ((.status // "") | type == "string"))' "$listing" >/dev/null; then
    echo "project listing was malformed (HTTP 200${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2
    return 2
  fi
}

initial_attempt=1
while true; do
  if fetch_listing_once; then
    initial_result=0
    break
  else
    initial_result=$?
  fi
  [ "$initial_result" -eq 2 ] && break
  [ "$initial_attempt" -lt 3 ] || break
  initial_attempt=$((initial_attempt + 1))
  sleep 5
done
if [ "$initial_result" -ne 0 ]; then
  echo "::error::unable to obtain a complete authenticated project listing" >&2
  exit 1
fi

projects=$(jq -r --arg p "$PREFIX" '.[] | select(.name | startswith($p)) | "\(.ref // .id) \(.status // "")"' "$listing")

# Reconcile through fresh authenticated list responses. A DELETE 403/400 or a
# single-project 404 is not evidence that a project is gone.
reconcile() {
  local ref=$1 attempt
  for attempt in $(seq 12); do
    if fetch_listing_once; then
      if jq -e --arg ref "$ref" 'any(.[]; ((.ref // .id) == $ref) and ((.status // "") != "GOING_DOWN") and ((.status // "") != "REMOVED"))' "$listing" >/dev/null; then
        echo "project $ref still active (list HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2
        if [ "$delete_attempt" -lt 3 ]; then
          case "$delete_code" in
            000|408|425|429|5??)
              delete_attempt=$((delete_attempt + 1))
              echo "retrying transient delete for project $ref (attempt $delete_attempt)" >&2
              sleep 5
              api_request DELETE "${SUPABASE_LIVE_API_URL}/v1/projects/${ref}" "$response"
              delete_code=$API_CODE
              echo "delete retry completed for project $ref (HTTP $delete_code${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2
              ;;
          esac
        fi
      else
        echo "project $ref reconciled as absent or terminal (list HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})"
        return 0
      fi
    elif [ "$?" -eq 2 ]; then
      echo "project $ref reconciliation evidence was unavailable or malformed" >&2
      return 1
    else
      echo "project $ref reconciliation read failed (HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2
    fi
    [ "$attempt" -lt 12 ] && sleep 5
  done
  return 1
}

failed=0
while read -r ref status; do
  [ -n "$ref" ] || continue
  case "$status" in
    GOING_DOWN | REMOVED)
      echo "skipping project $ref ($status)"
      continue
      ;;
  esac
  delete_attempt=1
  echo "deleting leftover project $ref (attempt $delete_attempt)"
  api_request DELETE "${SUPABASE_LIVE_API_URL}/v1/projects/${ref}" "$response"
  delete_code=$API_CODE
  case "$API_CODE" in
    2??) echo "delete accepted for project $ref (HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})" ;;
    *) echo "delete failed for project $ref (HTTP $API_CODE${API_REQUEST_ID:+ request $API_REQUEST_ID})" >&2 ;;
  esac
  if ! reconcile "$ref"; then
    echo "::error::project $ref remains active or cleanup evidence was unavailable" >&2
    failed=1
  fi
done <<< "$projects"
exit "$failed"
