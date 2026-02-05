#!/bin/bash
set -eou pipefail

# 1. Create user with publishable key
output=$(curl -sS "$API_URL/auth/v1/signup" \
  -H "apikey: $PUBLISHABLE_KEY" \
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
output=$(curl -sS -X DELETE "$API_URL/auth/v1/admin/users/$user_id" \
  -H "apikey: $SECRET_KEY" \
  -H 'Content-Type: application/json' \
)
if [[ "$output" != '{}' ]]; then
  echo 'User deletion with secret key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. Create user with legacy anon key
output=$(curl -sS "$API_URL/auth/v1/signup" \
  -H "Authorization: Bearer $ANON_KEY" \
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
output=$(curl -sS -X DELETE "$API_URL/auth/v1/admin/users/$user_id" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
)
if [[ "$output" != '{}' ]]; then
  echo 'User deletion with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
