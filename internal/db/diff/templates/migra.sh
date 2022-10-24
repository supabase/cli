#!/bin/sh
set -eu

# pin to latest version: https://pypi.org/project/migra/
pip install -qU migra==3.0.1663481299

# migra doesn't shutdown gracefully, so kill it ourselves
trap 'kill -9 %1' TERM

# accepts command line args as a list of schema to generate
for i in "$@"; do
    # migra exits 2 when differences are found
    migra --unsafe --schema="$i" "$SOURCE" "$TARGET" || status=$?
    if [ ${status:-2} -ne 2 ]; then
        exit $status
    fi
done
