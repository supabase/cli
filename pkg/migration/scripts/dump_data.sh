#!/usr/bin/env bash
set -euo pipefail

export PGHOST="$PGHOST"
export PGPORT="$PGPORT"
export PGUSER="$PGUSER"
export PGPASSWORD="$PGPASSWORD"
export PGDATABASE="$PGDATABASE"

# Disable triggers so that data dump can be restored exactly as it is
echo "SET session_replication_role = replica;
"

# Explanation of pg_dump flags:
#
#   --exclude-schema omit data from internal schemas as they are maintained by platform
#   --exclude-table  omit data from migration history tables as they are managed by platform
#   --column-inserts only column insert syntax is supported, ie. no copy from stdin
#   --schema '*'     include all other schemas by default
#
# Never delete SQL comments because multiline records may begin with them.
pg_dump \
    --data-only \
    --quote-all-identifier \
    --role "postgres" \
    --exclude-schema "${EXCLUDED_SCHEMAS:-}" \
    --exclude-table "auth.schema_migrations" \
    --exclude-table "storage.migrations" \
    --exclude-table "supabase_functions.migrations" \
    --schema "$INCLUDED_SCHEMAS" \
    ${EXTRA_FLAGS:-}

# Reset session config generated by pg_dump
echo "RESET ALL;"
