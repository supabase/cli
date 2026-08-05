import type { ServiceDef } from "@supabase/process-compose";
import type { DatabaseSeedFile } from "../StackConfig.ts";
import type { ServiceDependency } from "./service-utils.ts";

export type DatabaseBootstrapRuntime =
  | {
      readonly _tag: "Native";
      readonly postgresDir: string;
    }
  | {
      readonly _tag: "Docker";
      readonly containerName: string;
    };

interface DatabaseSeedServiceOptions {
  readonly runtime: DatabaseBootstrapRuntime;
  readonly dbPort: number;
  readonly seedFiles: ReadonlyArray<DatabaseSeedFile>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const psqlRunner = `
runtime="$1"
runtime_arg="$2"
shift 2

run_psql() {
  if [ "$runtime" = "native" ]; then
    "$runtime_arg" -h 127.0.0.1 "$@"
  else
    docker exec -i -e PGPASSWORD=postgres "$runtime_arg" psql "$@"
  fi
}
`.trim();

const psqlOptions = [
  "-p",
  "$SUPABASE_BOOTSTRAP_DB_PORT",
  "-U",
  "postgres",
  "-d",
  "postgres",
  "-v",
  "ON_ERROR_STOP=1",
  "--no-password",
  "--no-psqlrc",
].join(" ");

// Native psql may open caller-resolved files directly. Docker psql cannot see host paths, so the
// host-side Bash process streams SQL over `docker exec -i`. A new seed payload and its history
// write share one `--single-transaction` session: either both commit or neither does.

const seedScript = `
set -euo pipefail
${psqlRunner}

apply_seed() {
  file="$1"
  history_path="$2"
  checksum="$3"
  if [ "$runtime" = "native" ]; then
    run_psql ${psqlOptions} --single-transaction -v seed_path="$history_path" -v seed_hash="$checksum" -f "$file" -c "INSERT INTO supabase_migrations.seed_files(path, hash) VALUES (:'seed_path', :'seed_hash') ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash"
  else
    {
      cat "$file"
      printf '\n'
      cat <<'EOSQL'
INSERT INTO supabase_migrations.seed_files(path, hash) VALUES (:'seed_path', :'seed_hash') ON CONFLICT (path) DO UPDATE SET hash = EXCLUDED.hash;
EOSQL
    } | run_psql ${psqlOptions} --single-transaction -v seed_path="$history_path" -v seed_hash="$checksum"
  fi
}

update_seed_hash() {
  history_path="$1"
  checksum="$2"
  run_psql ${psqlOptions} --single-transaction -v seed_path="$history_path" -v seed_hash="$checksum" -c "UPDATE supabase_migrations.seed_files SET hash = :'seed_hash' WHERE path = :'seed_path'"
}

seed_count="$1"
shift

if [ "$seed_count" -gt 0 ]; then
  run_psql ${psqlOptions} <<'EOSQL'
SET lock_timeout = '4s';
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.seed_files (path text NOT NULL PRIMARY KEY, hash text NOT NULL);
EOSQL
fi

i=0
while [ "$i" -lt "$seed_count" ]; do
  file="$1"
  history_path="$2"
  checksum="$3"
  shift 3
  applied_hash="$(run_psql ${psqlOptions} -v seed_path="$history_path" -tAc "SELECT hash FROM supabase_migrations.seed_files WHERE path = :'seed_path'" || true)"
  if [ -z "$applied_hash" ]; then
    echo "Seeding data from $history_path..."
    apply_seed "$file" "$history_path" "$checksum"
  elif [ "$applied_hash" != "$checksum" ]; then
    echo "Updating seed hash to $history_path..."
    update_seed_hash "$history_path" "$checksum"
  fi
  i=$((i + 1))
done
`.trim();

function runtimeArgs(runtime: DatabaseBootstrapRuntime): ReadonlyArray<string> {
  return runtime._tag === "Native"
    ? ["native", `${runtime.postgresDir}/bin/psql`]
    : ["docker", runtime.containerName];
}

function runtimeEnv(runtime: DatabaseBootstrapRuntime, dbPort: number): Record<string, string> {
  if (runtime._tag === "Docker") {
    return { PGPASSWORD: "postgres", SUPABASE_BOOTSTRAP_DB_PORT: String(dbPort) };
  }
  return {
    PGPASSWORD: "postgres",
    SUPABASE_BOOTSTRAP_DB_PORT: String(dbPort),
    DYLD_LIBRARY_PATH: `${runtime.postgresDir}/lib`,
    LD_LIBRARY_PATH: `${runtime.postgresDir}/lib`,
  };
}

export const makeDatabaseSeedService = (opts: DatabaseSeedServiceOptions): ServiceDef => ({
  name: "postgres-seed",
  command: "bash",
  args: [
    "-c",
    seedScript,
    "postgres-seed",
    ...runtimeArgs(opts.runtime),
    String(opts.seedFiles.length),
    ...opts.seedFiles.flatMap((file) => [file.path, file.historyPath, file.checksum]),
  ],
  env: runtimeEnv(opts.runtime, opts.dbPort),
  dependencies: opts.dependencies,
  supervision: {},
  restart: "no",
});
