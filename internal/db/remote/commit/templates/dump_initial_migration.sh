#!/usr/bin/env bash
set -euo pipefail

pg_dump \
    --schema-only \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --schema '*' \
    --extension '*' \
    --no-comments \
    --dbname "$DB_URL" \
| sed 's/CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' \
| sed 's/ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/'
