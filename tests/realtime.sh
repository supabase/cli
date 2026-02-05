#!/bin/bash
set -eou pipefail

echo "Running Realtime tests..."

# 1. Join realtime with legacy key
output=$(echo '{"topic":"realtime:room1","ref":1,"event":"phx_join","payload":{"config":{"broadcast":{"ack":true},"presence":{"enabled":true},"private":false}}}' |\
  websocat 'ws://127.0.0.1:54321/realtime/v1/websocket?apikey=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0&vsn=1.0.0' \
)
if [[ $(echo "$output" | jq -r '.payload.status') != 'ok' ]]; then
  echo 'Joining realtime with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Join realtime with publishable key
output=$(echo '{"topic":"realtime:room1","ref":1,"event":"phx_join","payload":{"config":{"broadcast":{"ack":true},"presence":{"enabled":true},"private":false}}}' |\
  websocat 'ws://127.0.0.1:54321/realtime/v1/websocket?apikey=sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH&vsn=1.0.0' \
)
if [[ $(echo "$output" | jq -r '.payload.status') != 'ok' ]]; then
  echo 'Joining realtime as anon should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

## 3. Broadcast with secret key
curl -f 'http://127.0.0.1:54321/realtime/v1/api/broadcast' \
  -H 'apikey: sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"topic":"room1","event":"my_event","payload":{"foo":"bar"},"private":true}]}'
