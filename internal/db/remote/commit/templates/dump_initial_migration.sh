#!/usr/bin/env bash
set -euo pipefail

pg_dump \
    --schema-only \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --no-comments \
    --dbname "$DB_URL" \
| sed 's/ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/'
