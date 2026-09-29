#!/usr/bin/env bash
# Stages each workspace's Vitest results cache under <staging-dir>/<workspace>/<hash>/results.json
# before upload, so actions/upload-artifact's common-ancestor stripping can't drop the workspace
# from the artifact's paths.
#
# Usage: stage-vitest-results.sh <staging-dir> <glob-pattern>...
set -euo pipefail
shopt -s nullglob

staging_dir="$1"
shift

mkdir -p "$staging_dir"
for pattern in "$@"; do
  for cache in $pattern; do
    workspace="${cache%%/node_modules/*}"
    hash_dir="$(basename "$(dirname "$cache")")"
    dest="$staging_dir/$workspace/$hash_dir"
    mkdir -p "$dest"
    cp "$cache" "$dest/results.json"
  done
done
