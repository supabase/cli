#!/bin/sh
set -eu

if [ "${SUPABASE_SSL_DEBUG:-}" = "true" ]; then
    [ -n "${SOURCE:-}" ] && source_set=true || source_set=false
    [ -n "${TARGET:-}" ] && target_set=true || target_set=false
    echo "[ssl-debug] migra.sh uname=$(uname -a)" >&2
    echo "[ssl-debug] migra.sh source_set=$source_set target_set=$target_set schemas=$*" >&2
fi

# migra doesn't shutdown gracefully, so kill it ourselves
trap 'kill -9 %1' TERM

run_migra() {
    # additional flags for diffing extensions
    [ "$schema" = "extensions" ] && set -- --create-extensions-only --ignore-extension-versions "$@"
    migra --with-privileges --unsafe --schema="$schema" "$@"
}

# accepts command line args as a list of schema to generate
for schema in "$@"; do
    # migra exits 2 when differences are found
    run_migra "$SOURCE" "$TARGET" || status=$?
    if [ "${SUPABASE_SSL_DEBUG:-}" = "true" ]; then
        echo "[ssl-debug] migra.sh schema=$schema exit_status=${status:-0}" >&2
    fi
    if [ ${status:-2} -ne 2 ]; then
        exit $status
    fi
done
