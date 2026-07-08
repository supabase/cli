import type { ServiceDef } from "@supabase/process-compose";

interface PostgresInitOptions {
  readonly postgresDir: string;
  readonly dbPort: number;
  readonly dbPassword: string;
  /**
   * When false, append the SQL that Studio runs at cloud project creation to revoke the default
   * Data API privileges on the `public` schema so newly-created entities require explicit GRANTs.
   */
  readonly autoExposeNewTables: boolean;
}

/**
 * SQL that matches what Studio runs at cloud project creation when "Default privileges for new
 * entities" is off. Revokes the default GRANTs installed by the bundled initial schema so new
 * tables/sequences/functions in `public` owned by `postgres` are not reachable via the Data API
 * roles without explicit GRANTs.
 */
export const REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
`.trim();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export const makePostgresInitService = (opts: PostgresInitOptions): ServiceDef => {
  const pgBinDir = `${opts.postgresDir}/bin`;
  const pgLibDir = `${opts.postgresDir}/lib`;
  const migrationsDir = `${opts.postgresDir}/share/supabase-cli/migrations`;

  const psql = `${pgBinDir}/psql -h 127.0.0.1 -p ${opts.dbPort}`;
  const psqlOpts = `-v ON_ERROR_STOP=1 --no-password --no-psqlrc -v pgpass="$PGPASSWORD"`;

  const revokeStep = opts.autoExposeNewTables
    ? ""
    : `
  # Revoke default privileges for the Data API roles on schema public so new tables
  # require explicit GRANTs. Mirrors Studio's behaviour at cloud project creation.
  ${psql} ${psqlOpts} -U postgres -d postgres <<'EOSQL'
${REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL}
EOSQL
`;

  // Replaces calling migrate.sh (which spawns ~57 separate psql processes) with
  // chained -f flags that run all SQL files in a single psql session, cutting
  // postgres-init time from ~5s to ~1s.
  const script = `
export PATH="${pgBinDir}:$PATH"
export PGPASSWORD=${shellQuote(opts.dbPassword)}
db="${migrationsDir}"

# Check if already migrated (authenticator role created by initial-schema.sql)
if ${psql} -U supabase_admin -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='authenticator'" 2>/dev/null | grep -q 1; then
  echo "Database already initialized, updating passwords..."
else
  echo "Running Supabase migrations..."

  # Create postgres role if missing (as supabase_admin)
  ${psql} ${psqlOpts} -U supabase_admin -d postgres <<'EOSQL'
SELECT format('CREATE ROLE postgres SUPERUSER LOGIN PASSWORD %L', :'pgpass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres')\\gexec
ALTER DATABASE postgres OWNER TO postgres;
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
  ${psql} ${psqlOpts} -U postgres -d postgres <<'EOSQL'
SELECT format('ALTER ROLE supabase_admin WITH PASSWORD %L', :'pgpass')\\gexec
EOSQL

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
${revokeStep}fi

# Backfill schemas/databases used by docker-backed auxiliary services.
${psql} ${psqlOpts} -U postgres -d postgres <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;
EOSQL

if ! ${psql} -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '_supabase'" 2>/dev/null | grep -q 1; then
  ${psql} ${psqlOpts} -U postgres -d postgres -c "CREATE DATABASE _supabase WITH OWNER postgres"
fi

${psql} ${psqlOpts} -U postgres -d _supabase <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS _analytics;
ALTER SCHEMA _analytics OWNER TO postgres;
CREATE SCHEMA IF NOT EXISTS _supavisor;
ALTER SCHEMA _supavisor OWNER TO postgres;
EOSQL

# Always update role passwords (idempotent)
${psql} ${psqlOpts} -U supabase_admin -d postgres <<'EOSQL'
SELECT format('ALTER ROLE %I WITH PASSWORD %L', rolname, :'pgpass')
FROM pg_roles
WHERE rolname = ANY (ARRAY[
  'authenticator',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_functions_admin',
  'supabase_replication_admin',
  'supabase_read_only_user',
  'pgbouncer',
  'postgres'
])\\gexec
EOSQL
`;

  return {
    name: "postgres-init",
    command: "bash",
    args: ["-c", script],
    env: {
      DYLD_LIBRARY_PATH: pgLibDir,
      LD_LIBRARY_PATH: pgLibDir,
      PGPASSWORD: opts.dbPassword,
    },
    dependencies: [{ service: "postgres", condition: "healthy" }],
    supervision: {},
    restart: "no",
  };
};
