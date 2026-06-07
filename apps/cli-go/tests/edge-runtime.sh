#!/bin/bash
set -eou pipefail

# 0. Serve Edge Functions
# supabase --workdir tests functions serve

# 1. POST request with publishable key
output=$(curl -sS "$API_URL/functions/v1/hello-world" \
  -H "apikey: $PUBLISHABLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with publishable key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. POST request with legacy key
output=$(curl -sS "$API_URL/functions/v1/hello-world" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with anon key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. POST request with secret key
output=$(curl -sS "$API_URL/functions/v1/hello-world" \
  -H "apikey: $SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with secret key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 4. POST request with service role key
output=$(curl -sS "$API_URL/functions/v1/hello-world" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with service role key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
