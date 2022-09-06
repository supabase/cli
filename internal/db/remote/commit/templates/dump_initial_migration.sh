#!/usr/bin/env bash
set -euo pipefail

# Explanation of special flags:
#
#   --schema-only     omit data like migration history, pgsodium key, etc.
#   --exclude-schema  omit internal schemas as they are maintained by platform
#   --no-comments     only object owner can set comment, omit to allow restore by non-superuser
#   --extension "*"   prevents event triggers from being dumped
pg_dump \
    --schema-only \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --extension "*" \
    --no-comments \
    --dbname "$DB_URL" \
| sed 's/ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/'
