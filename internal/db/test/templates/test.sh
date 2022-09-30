#!/bin/sh

# move this dependency to base image
apt-get -qq update && apt-get -qq install postgresql-14-pgtap

# run postgres unit tests
pg_prove -h localhost -U postgres "$@"

cleanup() {
    # save the return code of the script
    status=$?
    # clean up test files
    rm -rf "$@"
    # actually quit
    exit $status
}

trap cleanup EXIT
