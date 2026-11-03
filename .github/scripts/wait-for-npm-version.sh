#!/usr/bin/env bash
# Usage: wait-for-npm-version.sh <version> <package>...
#
# npm lists a new version minutes after publish, and the registry CDN caches each packument per
# region and Accept header, so both the npm client and the abbreviated packument must serve it.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <version> <package>..." >&2
  exit 2
fi

version="$1"
shift
timeout="${WAIT_TIMEOUT_SECONDS:-900}"

npm_serves_version() {
  local pkg="$1"
  npm view "${pkg}@${version}" version --prefer-online > /dev/null &&
    curl -fsSL --max-time 30 -H 'Accept: application/vnd.npm.install-v1+json' "https://registry.npmjs.org/${pkg//\//%2f}" |
    jq -e --arg v "$version" '.versions | has($v)' > /dev/null
}

deadline=$((SECONDS + timeout))
for pkg in "$@"; do
  until npm_serves_version "$pkg"; do
    if (( SECONDS >= deadline )); then
      echo "::error::npm does not serve ${pkg}@${version} after ${timeout} seconds"
      exit 1
    fi
    echo "Waiting for npm to serve ${pkg}@${version}..."
    sleep 15
  done
done
