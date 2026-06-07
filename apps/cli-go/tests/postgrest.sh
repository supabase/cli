#!/bin/bash
set -eou pipefail

# 0. Create test table with RLS
# supabase --workdir tests migrations up

# 1. Create todo as service role
output=$(curl -sS "$API_URL/rest/v1/todos" \
  -H "apikey: $SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d '{"task": "New task", "done": false}' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Creating todo as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Create todo as anon role should fail
output=$(curl -sS "$API_URL/rest/v1/todos" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"task": "New task", "done": false}' \
)
if [[ $(echo "$output" | jq -r '.code') != '42501' ]]; then
  echo 'Creating todo as anon role should fail.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. List todos as anon role
output=$(curl -sS -G "$API_URL/rest/v1/todos" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H 'Content-Type: application/json' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Listing todos as anon role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 4. Delete todo as anon role should fail
output=$(curl -sS -X DELETE "$API_URL/rest/v1/todos?id=eq.1" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
)
if [[ $(echo "$output" | jq -r 'length') != '0' ]]; then
  echo 'Deleting todo as anon role should fail.' >&2
  echo "$output" | jq
  exit 1
fi

# 5. Delete todo as authenticated role (custom jwt)
output=$(curl -sS -X DELETE "$API_URL/rest/v1/todos?id=not.eq.0" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Deleting todo as authenticated role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
