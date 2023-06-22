#!/bin/bash
set -euo pipefail

# TODO: move this dependency to base image
if ! command -v pg_prove &> /dev/null; then
    apt-get -qq update
    apt-get -qq install make &> /dev/null
    echo | cpan -T TAP::Parser::SourceHandler::pgTAP &> /dev/null
fi

# temporarily enable pgtap
enable="create extension if not exists pgtap with schema extensions"
notice=$(psql -h localhost -U postgres -p 5432 -d postgres -c "$enable" 2>&1 >/dev/null)

files=$1
cleanup() {
    # save the return code of the script
    status=$?
    # disable pgtap if previously not enabled
    if [ -z "$notice" ]; then
        psql -h localhost -U postgres -p 5432 -d postgres -c "drop extension if exists pgtap" 2>&1 >/dev/null
    fi
    # clean up test files
    rm -rf "$files"
    # actually quit
    exit $status
}

trap cleanup EXIT

# run postgres unit tests
pg_prove -h localhost -U postgres --ext .pg --ext .sql -r "$files"
