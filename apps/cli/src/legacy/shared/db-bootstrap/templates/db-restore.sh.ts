/**
 * Transcribed verbatim from `apps/cli-go/internal/db/start/templates/restore.sh`
 * (Go `//go:embed templates/restore.sh`, `apps/cli-go/internal/db/start/start.go:40-41`,
 * exported as `restoreScript`). Heredoc'd into `/docker-entrypoint-initdb.d/migrate.sh`
 * by the Postgres container's entrypoint ONLY when `--from-backup` is set
 * (`StartDatabase`, `apps/cli-go/internal/db/start/start.go:143-159`) — restores roles
 * then schema from the bind-mounted `/etc/backup.sql`, then runs
 * `/etc/postgresql.schema.sql` (the initial schema, written by the same entrypoint) as a
 * post-init step so a restored database still gets Supabase's roles/passwords applied.
 * Not a Go `text/template`. Do not hand-edit — re-transcribe from the Go source if it
 * changes.
 */
export const LEGACY_START_DB_RESTORE_SH = `#!/bin/sh
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

export PGDATABASE="\${POSTGRES_DB:-postgres}"
export PGHOST="\${POSTGRES_HOST:-localhost}"
export PGPORT="\${POSTGRES_PORT:-5432}"
export PGPASSWORD="\${POSTGRES_PASSWORD:-}"

echo "$0: restoring roles"
cat "/etc/backup.sql" \\
| grep 'CREATE ROLE' \\
| grep -v 'supabase_admin' \\
| sed -E 's/^(CREATE ROLE postgres);/\\1 WITH SUPERUSER;/' \\
| psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin

echo "$0: restoring schema"
cat "/etc/backup.sql" \\
| sed -E 's/^\\\\(un)?restrict .*$/-- &/' \\
| sed -E 's/^CREATE VIEW /CREATE OR REPLACE VIEW /' \\
| sed -E 's/^CREATE FUNCTION /CREATE OR REPLACE FUNCTION /' \\
| sed -E 's/^CREATE TRIGGER /CREATE OR REPLACE TRIGGER /' \\
| sed -E 's/^GRANT ALL ON FUNCTION graphql_public\\./-- &/' \\
| sed -E 's/^CREATE ROLE /-- &/' \\
| sed -e '/ALTER ROLE postgres WITH / { h; $p; d; }' -e '$G' \\
| psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin

# run any post migration script to update role passwords
postinit="/etc/postgresql.schema.sql"
if [ -e "$postinit" ]; then
    echo "$0: running $postinit"
    psql -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -f "$postinit"
fi
`;
