#!/bin/bash
set -eou pipefail

dotenv=$("$@" --workdir tests status -o env)
source <(echo "$dotenv" | sed 's/^/export /')

./tests/auth.sh
./tests/postgrest.sh
./tests/storage.sh
./tests/realtime.sh
./tests/edge-runtime.sh
