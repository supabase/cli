#!/bin/bash
set -eou pipefail

dotenv=$("${1:-supabase}" --workdir tests status -o env)
export $(echo "$dotenv" | xargs)

for tc in ./tests/*.sh; do
  echo "Running $tc" >&2
  exec "$tc" &
done

wait
status="$?"

echo "All tests have completed." >&2
exit "$status"
