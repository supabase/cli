#!/bin/bash
set -eou pipefail

# 1. Publishable and secret keys are accepted as `apikey` header
output=$(curl 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"aSecurePassword123"}' \
)
if [[ $(echo "$output" | jq '.user.role') != 'authenticated' ]]; then
  echo 'User sign up with publishable key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Legacy anon and service_role key are accepted as `apikey` header
output=$(curl 'http://127.0.0.1:54321/auth/v1/signup' \
  -H 'apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"aSecurePassword123"}' \
)
if [[ $(echo "$output" | jq '.user.role') != 'authenticated' ]]; then
  echo 'User sign up with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
