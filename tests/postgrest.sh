#!/bin/bash
set -eou pipefail

# 0. Create test table with RLS
# supabase --workdir tests migrations up

echo "Running PostgREST tests..."

# 1. Create todo as service role
output=$(curl 'http://127.0.0.1:54321/rest/v1/todos' \
  -H 'apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz' \
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
output=$(curl 'http://127.0.0.1:54321/rest/v1/todos' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"task": "New task", "done": false}' \
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
if [[ $(echo "$output" | jq -r 'length') != '0' ]]; then
  echo 'Deleting todo as anon role should fail.' >&2
  echo "$output" | jq
  exit 1
fi

# 5. Delete todo as authenticated role (custom jwt)
output=$(curl -X DELETE 'http://127.0.0.1:54321/rest/v1/todos?id=not.eq.0' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU" \
  -H 'Content-Type: application/json' \
  -H 'Prefer: return=representation' \
)
if [[ $(echo "$output" | jq -r 'length') != '1' ]]; then
  echo 'Deleting todo as authenticated role should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
