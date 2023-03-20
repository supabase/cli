#!/usr/bin/env bash
set -euo pipefail

# Explanation of pg_dump flags:
#
#   --schema-only     omit data like migration history, pgsodium key, etc.
#   --exclude-schema  omit internal schemas as they are maintained by platform
#   --no-comments     only object owner can set comment, omit to allow restore by non-superuser
#   --extension '*'   prevents event triggers from being dumped, bash escaped with single quote
#
# Explanation of sed substitutions:
#
#   - do not alter superuser role "supabase_admin"
#   - do not include ACL changes on internal schemas
#   - do not include RLS policies on cron extension schema
pg_dump \
    --schema-only \
    --quote-all-identifier \
    --exclude-schema "$EXCLUDED_SCHEMAS" \
    --extension '*' \
    --no-comments \
    --dbname "$DB_URL" \
| sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' \
| sed -E "s/^GRANT (.+) ON (.+) \"($EXCLUDED_SCHEMAS)\"/-- &/" \
| sed -E "s/^REVOKE (.+) ON (.+) \"($EXCLUDED_SCHEMAS)\"/-- &/" \
| sed -E 's/^CREATE POLICY "cron_job_/-- &/' \
| sed -E 's/^ALTER TABLE "cron"/-- &/'

# Reset session config generated by pg_dump
echo "RESET ALL;"
