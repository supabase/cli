import type { ServiceDef } from "@supabase/process-compose";
import { dockerContainerName, type StackIdentity } from "../StackIdentity.ts";
import type { ContainerRuntimeOptions, ServiceDependency } from "./service-utils.ts";

interface PostgresInitOptions {
  readonly postgresDir: string;
  readonly dbPort: number;
  /**
   * When false, append the SQL that Studio runs at cloud project creation to revoke the default
   * Data API privileges on the `public` schema so newly-created entities require explicit GRANTs.
   */
  readonly autoExposeNewTables: boolean;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

interface DockerPostgresInitOptions extends ContainerRuntimeOptions {
  readonly dbPort: number;
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly autoExposeNewTables: boolean;
  readonly identity: StackIdentity;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

/**
 * SQL that matches what Studio runs at cloud project creation when "Default privileges for new
 * entities" is off. Revokes the default GRANTs installed by the bundled initial schema so new
 * tables/sequences/functions in `public` owned by `postgres` are not reachable via the Data API
 * roles without explicit GRANTs.
 */
const REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL = `
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
`.trim();

const dockerPostgresSchemaSql = (opts: DockerPostgresInitOptions) =>
  `
\\set jwt_secret \`echo "$JWT_SECRET"\`
\\set jwt_exp \`echo "$JWT_EXP"\`
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
ALTER USER postgres WITH PASSWORD 'postgres';
ALTER USER authenticator WITH PASSWORD 'postgres';
ALTER USER supabase_auth_admin WITH PASSWORD 'postgres';
ALTER USER supabase_storage_admin WITH PASSWORD 'postgres';
ALTER USER supabase_replication_admin WITH PASSWORD 'postgres';
ALTER USER supabase_read_only_user WITH PASSWORD 'postgres';
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;
${opts.autoExposeNewTables ? "" : REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL}
SELECT 'CREATE DATABASE _supabase WITH OWNER postgres'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '_supabase')\\gexec
\\connect _supabase
CREATE SCHEMA IF NOT EXISTS _analytics;
ALTER SCHEMA _analytics OWNER TO postgres;
CREATE SCHEMA IF NOT EXISTS _supavisor;
ALTER SCHEMA _supavisor OWNER TO postgres;
`.trim();

export const makePostgresInitServiceDocker = (opts: DockerPostgresInitOptions): ServiceDef => ({
  name: "postgres-init",
  command: opts.runtime,
  args: [
    "exec",
    "-e",
    "PGPASSWORD",
    "-e",
    "JWT_SECRET",
    "-e",
    "JWT_EXP",
    dockerContainerName("postgres", opts.identity.key),
    "sh",
    "-c",
    `/opt/postgres/bin/psql -h 127.0.0.1 -p ${opts.dbPort} -v ON_ERROR_STOP=1 --no-password --no-psqlrc -U supabase_admin -d postgres <<'EOSQL'
${dockerPostgresSchemaSql(opts)}
EOSQL`,
  ],
  env: {
    PGPASSWORD: "postgres",
    JWT_SECRET: opts.jwtSecret,
    JWT_EXP: String(opts.jwtExpiry),
  },
  dependencies: opts.dependencies,
  supervision: {},
  restart: "no",
});

export const makePostgresInitService = (opts: PostgresInitOptions): ServiceDef => {
  const pgBinDir = `${opts.postgresDir}/bin`;
  const pgLibDir = `${opts.postgresDir}/lib`;
  const migrationsDir = `${opts.postgresDir}/share/supabase-cli/migrations`;

  // Keep executable and SQL-file paths in arrays so cache roots containing
  // whitespace remain single argv entries all the way to psql.
  const psqlPath = `${pgBinDir}/psql`;
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const psqlArray = `psql=(${shellQuote(psqlPath)} -h 127.0.0.1 -p ${opts.dbPort})`;

  // Replaces calling migrate.sh (which spawns ~57 separate psql processes) with
  // chained -f flags that run all SQL files in a single psql session, cutting
  // postgres-init time from ~5s to ~1s.
  const script = `
set -e
export PATH="${pgBinDir}:$PATH"
export PGPASSWORD=postgres
db="${migrationsDir}"
${psqlArray}
psql_opts=(-v ON_ERROR_STOP=1 --no-password --no-psqlrc)

init_completion_sql=$(cat <<'EOSQL'
ALTER USER supabase_admin WITH PASSWORD 'postgres';
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.cli_init (
  phase text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO supabase_migrations.cli_init (phase)
VALUES ('init')
ON CONFLICT (phase) DO NOTHING;
EOSQL
)

migration_completion_sql=$(cat <<'EOSQL'
${opts.autoExposeNewTables ? "" : REVOKE_DEFAULT_DATA_API_PRIVILEGES_SQL}
INSERT INTO supabase_migrations.cli_init (phase)
VALUES ('complete')
ON CONFLICT (phase) DO UPDATE SET completed_at = EXCLUDED.completed_at;
EOSQL
)

# The init phase is committed independently so a failed migration phase can
# resume without replaying non-idempotent bundled init scripts.
if "\${psql[@]}" -U supabase_admin -d postgres -tAc "SELECT 1 FROM supabase_migrations.cli_init WHERE phase = 'init'" 2>/dev/null | grep -q 1; then
  echo "Database initial schema already initialized"
else
  echo "Running Supabase migrations..."

  # Create postgres role if missing (as supabase_admin)
  "\${psql[@]}" "\${psql_opts[@]}" -U supabase_admin -d postgres <<'EOSQL'
do $$
begin
  if not exists (select from pg_roles where rolname = 'postgres') then
    create role postgres superuser login password 'postgres';
    alter database postgres owner to postgres;
  end if;
end $$
EOSQL

  # Run all init-scripts in a single psql session (as postgres)
  init_flags=()
  for sql in "$db"/init-scripts/*.sql; do
    [ -f "$sql" ] && init_flags+=( -f "$sql" )
  done
  "\${psql[@]}" "\${psql_opts[@]}" --single-transaction -U postgres -d postgres "\${init_flags[@]}" -c "$init_completion_sql"
fi

if "\${psql[@]}" -U supabase_admin -d postgres -tAc "SELECT 1 FROM supabase_migrations.cli_init WHERE phase = 'complete'" 2>/dev/null | grep -q 1; then
  echo "Database migrations already initialized"
else
  echo "Running Supabase migrations..."

  # Run all migrations in a single psql session (as supabase_admin)
  migrate_flags=()
  for sql in "$db"/migrations/*.sql; do
    [ -f "$sql" ] && migrate_flags+=( -f "$sql" )
  done
  "\${psql[@]}" "\${psql_opts[@]}" --single-transaction -U supabase_admin -d postgres "\${migrate_flags[@]}" -c "$migration_completion_sql"

  # Reset stats (non-fatal, matches migrate.sh)
  "\${psql[@]}" "\${psql_opts[@]}" -U supabase_admin -d postgres -c 'SELECT extensions.pg_stat_statements_reset(); SELECT pg_stat_reset();' || true
fi

# Backfill schemas/databases used by docker-backed auxiliary services.
"\${psql[@]}" "\${psql_opts[@]}" -U postgres -d postgres <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;
EOSQL

if ! "\${psql[@]}" -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '_supabase'" 2>/dev/null | grep -q 1; then
  "\${psql[@]}" "\${psql_opts[@]}" -U postgres -d postgres -c "CREATE DATABASE _supabase WITH OWNER postgres"
fi

"\${psql[@]}" "\${psql_opts[@]}" -U postgres -d _supabase <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS _analytics;
ALTER SCHEMA _analytics OWNER TO postgres;
CREATE SCHEMA IF NOT EXISTS _supavisor;
ALTER SCHEMA _supavisor OWNER TO postgres;
EOSQL

# Always update role passwords (idempotent)
"\${psql[@]}" -U supabase_admin -d postgres -c "
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
    dependencies: opts.dependencies,
    supervision: {},
    restart: "no",
  };
};
