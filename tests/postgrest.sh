#!/bin/bash
set -eou pipefail

# 0. Create test table with RLS
# supabase --workdir tests migrations up

# 1. Create todo as service role
output=$(curl 'http://127.0.0.1:54321/rest/v1/todos' \
  -H 'apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz' \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
  -d '{"task": "New task", "done": false}'
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Creating todo as service role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Create todo as anon role should fail
output=$(curl 'http://127.0.0.1:54321/rest/v1/todos' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"task": "New task", "done": false}'
)
if [[ $(echo "$output" | jq -r '.code') != '42501' ]]; then
  echo 'Creating todo as anon role should fail.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. List todos as anon role
output=$(curl -G 'http://127.0.0.1:54321/rest/v1/todos' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Listing todos as anon role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 4. Delete todo as anon role should fail
output=$(curl -X DELETE 'http://127.0.0.1:54321/rest/v1/todos?id=eq.1' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Deleting todo as anon role should fail.' >&2
  echo "$output" | jq
  exit 1
fi

# 5. Delete todo as authenticated role (custom jwt)
output=$(curl -X DELETE 'http://127.0.0.1:54321/rest/v1/todos?id=eq.1' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Authorization: Bearer eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxLTIxZDgtNGYyZS1iNzE5LWMyMjQwYTg0MGQ5MCIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NzAyNjE4NTcsImlhdCI6MTc3MDI2MDA1NywiaXNfYW5vbnltb3VzIjp0cnVlLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.iYBqhBe9frFxmuatOzX5EtkX4h0-dFcC_d8dGeZImRA_LdVV1_fyP0MUJYm9ttR2ipL2zQ7WrjR7dbU2kBb9YQ' \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Deleting todo as authenticated role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
