#!/bin/sh
set -eu

#######################################
# Fast replacement for migrate.sh — chains multiple -f flags per psql
# invocation so all SQL files run in a single connection (~2 sessions
# instead of ~57 separate psql processes).
#
# Drop-in replacement: same env vars, same directory layout, same behavior.
#
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

PSQL_OPTS="-v ON_ERROR_STOP=1 --no-password --no-psqlrc"

# if args are supplied, simply forward to dbmate
connect="$PGPASSWORD@$PGHOST:$PGPORT/$PGDATABASE?sslmode=disable"
if [ "$#" -ne 0 ]; then
    export DATABASE_URL="${DATABASE_URL:-postgres://supabase_admin:$connect}"
    exec dbmate "$@"
    exit 0
fi

db=$( cd -- "$( dirname -- "$0" )" > /dev/null 2>&1 && pwd )
if [ -z "${USE_DBMATE:-}" ]; then
    # Create postgres role if missing (as supabase_admin)
    psql $PSQL_OPTS -U supabase_admin <<'EOSQL'
do $$
begin
  if not exists (select from pg_roles where rolname = 'postgres') then
    create role postgres superuser login password 'postgres';
    alter database postgres owner to postgres;
  end if;
end $$
EOSQL

    # Build -f flags for init-scripts, then run in a single psql session (as postgres)
    init_flags=""
    for sql in "$db"/init-scripts/*.sql; do
        [ -f "$sql" ] && init_flags="$init_flags -f $sql"
    done
    if [ -n "$init_flags" ]; then
        echo "$0: running init-scripts (batched)"
        psql $PSQL_OPTS -U postgres $init_flags
    fi

    psql $PSQL_OPTS -U postgres -c "ALTER USER supabase_admin WITH PASSWORD '$PGPASSWORD'"

    # Build -f flags for migrations, then run in a single psql session (as supabase_admin)
    migrate_flags=""
    for sql in "$db"/migrations/*.sql; do
        [ -f "$sql" ] && migrate_flags="$migrate_flags -f $sql"
    done
    if [ -n "$migrate_flags" ]; then
        echo "$0: running migrations (batched)"
        psql $PSQL_OPTS -U supabase_admin $migrate_flags
    fi
else
    psql $PSQL_OPTS -U supabase_admin <<EOSQL
  create role postgres superuser login password '$PGPASSWORD';
  alter database postgres owner to postgres;
EOSQL
    # run init scripts as postgres user
    DBMATE_MIGRATIONS_DIR="$db/init-scripts" DATABASE_URL="postgres://postgres:$connect" dbmate --no-dump-schema migrate
    psql $PSQL_OPTS -U postgres -c "ALTER USER supabase_admin WITH PASSWORD '$PGPASSWORD'"
    # run migrations as super user - postgres user demoted in post-setup
    DBMATE_MIGRATIONS_DIR="$db/migrations" DATABASE_URL="postgres://supabase_admin:$connect" dbmate --no-dump-schema migrate
fi

# run any post migration script to update role passwords
postinit="/etc/postgresql.schema.sql"
if [ -e "$postinit" ]; then
    echo "$0: running $postinit"
    psql $PSQL_OPTS -U supabase_admin -f "$postinit"
fi

# once done with everything, reset stats from init
psql $PSQL_OPTS -U supabase_admin -c 'SELECT extensions.pg_stat_statements_reset(); SELECT pg_stat_reset();' || true
