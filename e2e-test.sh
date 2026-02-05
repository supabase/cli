#!/bin/bash
set -eou pipefail

dotenv=$("${1:-supabase}" --workdir tests status -o env)
source <(echo "$dotenv" | sed 's/^/export /')

for tc in ./tests/*.sh; do
  echo "Running $tc" >&2
  exec "$tc" &
done

wait
echo "All tests have completed."
