#!/bin/bash
set -eou pipefail

echo "Running Auth tests..."

# 1. Create user with publishable key
output=$(curl 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"aSecurePassword123"}' \
)
if [[ $(echo "$output" | jq -r '.user.role') != 'authenticated' ]]; then
  echo 'User sign up with publishable key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Delete user with secret key
user_id=$(echo "$output" | jq -r '.user.id')
output=$(curl -X DELETE "http://127.0.0.1:54321/auth/v1/admin/users/$user_id" \
  -H "apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz" \
  -H 'Content-Type: application/json' \
)
if [[ "$output" != '{}' ]]; then
  echo 'User deletion with secret key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. Create user with legacy anon key
output=$(curl 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"aSecurePassword123"}' \
)
if [[ $(echo "$output" | jq -r '.user.role') != 'authenticated' ]]; then
  echo 'User sign up with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 4. Delete user with legacy service role key
user_id=$(echo "$output" | jq -r '.user.id')
output=$(curl -X DELETE "http://127.0.0.1:54321/auth/v1/admin/users/$user_id" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU" \
  -H 'Content-Type: application/json' \
)
if [[ "$output" != '{}' ]]; then
  echo 'User deletion with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
