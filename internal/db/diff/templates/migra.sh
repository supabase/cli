#!/bin/sh
set -eu

# pin to latest version: https://pypi.org/project/migra/
pip install -qU migra==3.0.1658662267

# fix enum: https://github.com/djrobstep/schemainspect/pull/63
sed -i 's/  and e.objid is null/  -- and e.objid is null/g' \
/usr/local/lib/python3.9/site-packages/schemainspect/pg/sql/enums.sql

# migra doesn't shutdown gracefully, so kill it ourselves
trap 'kill -9 %1' TERM

# accepts command line args as a list of schema to generate
for i in "$@"; do
    # migra exits 2 when differences are found
    migra --unsafe --schema="$i" "$SOURCE" "$TARGET" || true
done
