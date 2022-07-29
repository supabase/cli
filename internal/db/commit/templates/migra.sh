#!/bin/sh
set -eu

# fix enum: https://github.com/djrobstep/schemainspect/pull/63
sed -i 's/  and e.objid is null/  -- and e.objid is null/g' \
/usr/local/lib/python3.9/site-packages/schemainspect/pg/sql/enums.sql

# diff public schema only
migra --unsafe --schema=public "$SOURCE" "$TARGET"
