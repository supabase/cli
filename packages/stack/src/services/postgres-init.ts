import type { ServiceDef } from "@supabase/process-compose";

interface PostgresInitOptions {
  readonly postgresDir: string;
  readonly dbPort: number;
}

export const makePostgresInitService = (opts: PostgresInitOptions): ServiceDef => {
  const pgBinDir = `${opts.postgresDir}/bin`;
  const pgLibDir = `${opts.postgresDir}/lib`;
  const migrationsDir = `${opts.postgresDir}/share/supabase-cli/migrations`;

  const psql = `${pgBinDir}/psql -h 127.0.0.1 -p ${opts.dbPort}`;
  const psqlOpts = `-v ON_ERROR_STOP=1 --no-password --no-psqlrc`;

  // Replaces calling migrate.sh (which spawns ~57 separate psql processes) with
  // chained -f flags that run all SQL files in a single psql session, cutting
  // postgres-init time from ~5s to ~1s.
  const script = `
export PATH="${pgBinDir}:$PATH"
export PGPASSWORD=postgres
db="${migrationsDir}"

# Check if already migrated (authenticator role created by initial-schema.sql)
if ${psql} -U supabase_admin -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='authenticator'" 2>/dev/null | grep -q 1; then
  echo "Database already initialized, updating passwords..."
else
  echo "Running Supabase migrations..."

  # Create postgres role if missing (as supabase_admin)
  ${psql} ${psqlOpts} -U supabase_admin -d postgres <<'EOSQL'
do $$
begin
  if not exists (select from pg_roles where rolname = 'postgres') then
    create role postgres superuser login password 'postgres';
    alter database postgres owner to postgres;
  end if;
end $$
EOSQL

  # Run all init-scripts in a single psql session (as postgres)
  init_flags=""
  for sql in "$db"/init-scripts/*.sql; do
    [ -f "$sql" ] && init_flags="$init_flags -f $sql"
  done
  if [ -n "$init_flags" ]; then
    ${psql} ${psqlOpts} -U postgres -d postgres $init_flags
  fi

  # Set supabase_admin password (as postgres)
  ${psql} ${psqlOpts} -U postgres -d postgres -c "ALTER USER supabase_admin WITH PASSWORD 'postgres'"

  # Run all migrations in a single psql session (as supabase_admin)
  migrate_flags=""
  for sql in "$db"/migrations/*.sql; do
    [ -f "$sql" ] && migrate_flags="$migrate_flags -f $sql"
  done
  if [ -n "$migrate_flags" ]; then
    ${psql} ${psqlOpts} -U supabase_admin -d postgres $migrate_flags
  fi

  # Reset stats (non-fatal, matches migrate.sh)
  ${psql} ${psqlOpts} -U supabase_admin -d postgres -c 'SELECT extensions.pg_stat_statements_reset(); SELECT pg_stat_reset();' || true
fi

# Always update role passwords (idempotent)
${psql} -U supabase_admin -d postgres -c "
DO \\$\\$
DECLARE
  roles text[] := ARRAY['authenticator','supabase_auth_admin','supabase_storage_admin','supabase_functions_admin','supabase_replication_admin','supabase_read_only_user','postgres'];
  r text;
BEGIN
  FOREACH r IN ARRAY roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('ALTER ROLE %I WITH PASSWORD ''postgres''', r);
    END IF;
  END LOOP;
END
\\$\\$;
"
`;

  return {
    name: "postgres-init",
    command: "bash",
    args: ["-c", script],
    env: {
      DYLD_LIBRARY_PATH: pgLibDir,
      LD_LIBRARY_PATH: pgLibDir,
      PGPASSWORD: "postgres",
    },
    dependencies: [{ service: "postgres", condition: "healthy" }],
    supervision: {},
    restart: "no",
  };
};
