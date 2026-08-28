#!/usr/bin/env bash
# Removes what an aborted recording left behind: the demo workdir, and the
# worker the tape deploys if its own `delete` step never ran.
#
#   apps/cli/demo/cleanup.sh
set -euo pipefail

demo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="$demo_dir/.workdir"
worker="${1:-hello-api}"

if [[ -x "$workdir/bin/supabase" ]]; then
  cd "$workdir"
  SUPABASE_NO_UPDATE_NOTIFIER=1 "$workdir/bin/supabase" workers delete "$worker" --yes || true
fi

rm -rf "$workdir"
echo "Cleaned up $worker and $workdir"
