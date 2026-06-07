#!/bin/bash
set -eou pipefail

# 1. Create test bucket as service role
output=$(curl -sS "$API_URL/storage/v1/bucket" \
  -H "apikey: $SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}' \
)
if [[ $(echo "$output" | jq -r '.name') != 'test' ]]; then
  echo 'Creating storage bucket as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Create test bucket as service role (legacy key)
output=$(curl -sS -X DELETE "$API_URL/storage/v1/bucket/test" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Successfully deleted' ]]; then
  echo 'Deleting storage bucket as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. Unauthenticated requests are rejected
output=$(curl -sS "$API_URL/storage/v1/bucket" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}' \
)
if [[ $(echo "$output" | jq -r '.error') != 'Unauthorized' ]]; then
  echo 'Unauthenticated requests should be rejected.' >&2
  echo "$output" | jq
  exit 1
fi
