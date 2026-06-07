#!/bin/sh
set -eu

#######################################
# Used by both ami and docker builds to initialise database schema.
# Env vars:
#   POSTGRES_DB        defaults to postgres
#   POSTGRES_HOST      defaults to localhost
#   POSTGRES_PORT      defaults to 5432
#   POSTGRES_PASSWORD  defaults to ""
#   USE_DBMATE         defaults to ""
# Exit code:
#   0 if migration succeeds, non-zero on error.
#######################################

export PGDATABASE="${POSTGRES_DB:-postgres}"
export PGHOST="${POSTGRES_HOST:-localhost}"
export PGPORT="${POSTGRES_PORT:-5432}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

echo "$0: restoring roles"
cat "/etc/backup.sql" \
| grep 'CREATE ROLE' \
| grep -v 'supabase_admin' \
| sed -E 's/^(CREATE ROLE postgres);/\1 WITH SUPERUSER;/' \
| psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin

echo "$0: restoring schema"
cat "/etc/backup.sql" \
| sed -E 's/^\\(un)?restrict .*$/-- &/' \
| sed -E 's/^CREATE VIEW /CREATE OR REPLACE VIEW /' \
| sed -E 's/^CREATE FUNCTION /CREATE OR REPLACE FUNCTION /' \
| sed -E 's/^CREATE TRIGGER /CREATE OR REPLACE TRIGGER /' \
| sed -E 's/^GRANT ALL ON FUNCTION graphql_public\./-- &/' \
| sed -E 's/^CREATE ROLE /-- &/' \
| sed -e '/ALTER ROLE postgres WITH / { h; $p; d; }' -e '$G' \
| psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin

# run any post migration script to update role passwords
postinit="/etc/postgresql.schema.sql"
if [ -e "$postinit" ]; then
    echo "$0: running $postinit"
    psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -f "$postinit"
fi
