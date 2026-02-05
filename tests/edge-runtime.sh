#!/bin/bash
set -eou pipefail

# 1. POST request with publishable key
output=$(curl 'http://127.0.0.1:54321/functions/v1/hello-world' \
  -H 'apikey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with publishable key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. POST request with legacy key
output=$(curl 'http://127.0.0.1:54321/functions/v1/hello-world' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with anon key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 3. POST request with secret key
output=$(curl 'http://127.0.0.1:54321/functions/v1/hello-world' \
  -H 'apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with secret key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 4. POST request with service role key
output=$(curl 'http://127.0.0.1:54321/functions/v1/hello-world' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Functions"}' \
)
if [[ $(echo "$output" | jq -r '.message') != 'Hello Functions!' ]]; then
  echo 'Edge Function request with service role key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi
