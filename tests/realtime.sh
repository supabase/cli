#!/bin/bash
set -eou pipefail

# 1. Join realtime with legacy key
output=$(echo '{"topic":"realtime:room1","ref":1,"event":"phx_join","payload":{"config":{"broadcast":{"ack":true},"presence":{"enabled":true},"private":false}}}' |\
  websocat "ws://127.0.0.1:54321/realtime/v1/websocket?apikey=$ANON_KEY&vsn=1.0.0" \
)
if [[ $(echo "$output" | jq -r '.payload.status') != 'ok' ]]; then
  echo 'Joining realtime with legacy key should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

# 2. Join realtime with publishable key
output=$(echo '{"topic":"realtime:room1","ref":1,"event":"phx_join","payload":{"config":{"broadcast":{"ack":true},"presence":{"enabled":true},"private":false}}}' |\
  websocat "ws://127.0.0.1:54321/realtime/v1/websocket?apikey=$PUBLISHABLE_KEY&vsn=1.0.0" \
)
if [[ $(echo "$output" | jq -r '.payload.status') != 'ok' ]]; then
  echo 'Joining realtime as anon should succeed.' >&2
  echo "$output" | jq
  exit 1
fi

## 3. Broadcast with secret key
curl -sSf "$API_URL/realtime/v1/api/broadcast" \
  -H "apikey: $SECRET_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"topic":"room1","event":"my_event","payload":{"foo":"bar"},"private":true}]}'
