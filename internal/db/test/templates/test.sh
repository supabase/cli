#!/bin/bash
set -euo pipefail

# TODO: move this dependency to base image
if ! command -v pg_prove &> /dev/null; then
    apt-get -qq update && apt-get -qq install postgresql-14-pgtap
fi

# temporarily enable pgtap
enable="create extension if not exists pgtap with schema extensions"
notice=$(psql -h localhost -U postgres -p 5432 -d postgres -c "$enable" 2>&1 >/dev/null)

# run postgres unit tests
pg_prove -h localhost -U postgres -r "$@"

cleanup() {
    # save the return code of the script
    status=$?
    # disable pgtap
    if [ -z "$notice" ]; then
        psql -h localhost -U postgres -p 5432 -d postgres -c "drop extension if exists pgtap"
    fi
    # clean up test files
    rm -rf "$@"
    # actually quit
    exit $status
}

trap cleanup EXIT
