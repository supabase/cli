#!/usr/bin/env bash
# Install the untrusted PR workspace without loading its bunfig/.npmrc/.env/.pnpmfile.
# Toolchain (bun, pnpm, go) must already be on PATH from the trusted pin.
set -euo pipefail

PR_ROOT="${1:?usage: install-pr-cli.sh PR_ROOT}"
cd "$PR_ROOT"

for f in bunfig.toml bunfig.toml.local .npmrc .env .env.local .env.production \
  .pnpmfile.cjs .pnpmfile.js .pnpmfile.mjs pnpmfile.js; do
  if [ -e "$f" ]; then
    mv "$f" "${f}.untrusted"
  fi
done

userconfig="${RUNNER_TEMP:-/tmp}/dogfood-npmrc-user"
globalconfig="${RUNNER_TEMP:-/tmp}/dogfood-npmrc-global"
# Distinct empty paths — npm rejects the same path for user and global config.
: >"$userconfig"
: >"$globalconfig"
export NPM_CONFIG_USERCONFIG="$userconfig"
export NPM_CONFIG_GLOBALCONFIG="$globalconfig"

# Lifecycle scripts are untrusted PR code sitting next to the trusted tree.
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org/
