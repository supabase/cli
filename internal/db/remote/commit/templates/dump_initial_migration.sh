#!/usr/bin/env bash
set -euo pipefail

pg_dump \
    --schema-only \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --schema '*' \
    --extension '*' \
    --dbname "$DB_URL" \
| sed 's/CREATE SCHEMA "public"/-- CREATE SCHEMA "public"/' \
| sed 's/COMMENT ON EXTENSION/-- COMMENT ON EXTENSION/' \
| sed 's/ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/'
