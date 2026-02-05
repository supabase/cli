#!/bin/bash
set -eou pipefail

# 1. Create test bucket as service role
output=$(curl -sS 'http://127.0.0.1:54321/storage/v1/bucket' \
  -H 'apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz' \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}' \
)
if [[ $(echo "$output" | jq -r '.name') != 'test' ]]; then
  echo 'Creating storage bucket as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Create test bucket as service role (legacy key)
output=$(curl -sS -X DELETE 'http://127.0.0.1:54321/storage/v1/bucket/test' \
  -H 'apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU' \
  -H 'Content-Type: application/json' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Successfully deleted' ]]; then
  echo 'Deleting storage bucket as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. Unauthenticated requests are rejected
output=$(curl -sS 'http://127.0.0.1:54321/storage/v1/bucket' \
  -H 'Content-Type: application/json' \
  -d '{"name":"test"}' \
)
if [[ $(echo "$output" | jq -r '.error') != 'Unauthorized' ]]; then
  echo 'Unauthenticated requests should be rejected.' >&2
  echo "$output" | jq
  exit 1
fi
