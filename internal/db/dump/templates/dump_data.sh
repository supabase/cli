#!/usr/bin/env bash
set -euo pipefail

# Explanation of pg_dump flags:
#
#   --exclude-schema omit data from internal schemas as they are maintained by platform
#   --exclude-table  omit data from migration history tables as they are managed by platform
#   --column-inserts only column insert syntax is supported, ie. no copy from stdin
#   --schema '*'     include all other schemas by default
pg_dump \
    --data-only \
    --column-inserts \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --exclude-table "auth.schema_migrations" \
    --exclude-table "storage.migrations" \
    --exclude-table "supabase_functions.migrations" \
    --schema '*' \
    --dbname "$DB_URL"

# Reset session config generated by pg_dump
echo "RESET ALL;"
