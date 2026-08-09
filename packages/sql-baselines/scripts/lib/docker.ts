import { $ } from "bun";

/**
 * Thin wrappers around the docker CLI for the generation pipeline. The
 * pipeline mirrors the CLI's `db start`: a postgres container whose
 * entrypoint applies the CLI's static templates on first init, then one-shot
 * service migrate jobs on the same network.
 */

export interface PostgresContainer {
  readonly name: string;
  /** Connection URL reachable from the host (for pg-delta). */
  readonly url: string;
}

export const createNetwork = async (name: string): Promise<void> => {
  await $`docker network create ${name}`.quiet();
};

export const removeNetwork = async (name: string): Promise<void> => {
  await $`docker network rm ${name}`.quiet().nothrow();
};

export const removeContainer = async (name: string): Promise<void> => {
  await $`docker rm -f ${name}`.quiet().nothrow();
};

export interface StartPostgresOptions {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  /** Directory mounted read-only at /baselines-init inside the container. */
  readonly initDir: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Start `supabase/postgres` the way the CLI does (`NewContainerConfig` in
 * `apps/cli-go/internal/db/start/start.go`): the image's own entrypoint runs
 * `/etc/postgresql.schema.sql` on a virgin data directory, which is where the
 * CLI's static templates (role passwords, `_realtime` schema, webhooks,
 * `_supabase` database) come from.
 */
export const startPostgres = async (opts: StartPostgresOptions): Promise<PostgresContainer> => {
  const envArgs = Object.entries(opts.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  await $`docker run -d --name ${opts.name} --network ${opts.network} \
    -p 127.0.0.1:0:5432 \
    -v ${opts.initDir}:/baselines-init:ro \
    ${envArgs} \
    --entrypoint sh ${opts.image} /baselines-init/entrypoint.sh`.quiet();
  const port = await $`docker port ${opts.name} 5432/tcp`.text();
  const hostPort = port.trim().split("\n")[0]?.split(":").at(-1);
  if (hostPort === undefined) {
    throw new Error(`could not determine host port for ${opts.name}`);
  }
  return {
    name: opts.name,
    url: `postgresql://supabase_admin:${opts.env["POSTGRES_PASSWORD"]}@127.0.0.1:${hostPort}/postgres`,
  };
};

/**
 * Wait until postgres accepts TCP connections *and* the entrypoint's init SQL
 * has completed (`_supabase` is the last database the templates create).
 */
export const waitForInit = async (
  container: PostgresContainer,
  timeoutMs = 120_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result =
      await $`docker exec -e PGPASSWORD=postgres ${container.name} psql -U supabase_admin -h 127.0.0.1 -tAc ${"SELECT 1 FROM pg_database WHERE datname = '_supabase'"}`
        .quiet()
        .nothrow();
    if (result.exitCode === 0 && result.stdout.toString().trim() === "1") {
      return;
    }
    await Bun.sleep(2000);
  }
  throw new Error(`postgres container ${container.name} did not initialize within ${timeoutMs}ms`);
};

export interface OneShotJob {
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cmd: ReadonlyArray<string>;
}

/** Run a one-shot migrate job to completion, like the CLI's `DockerRunJob`. */
export const runJob = async (network: string, job: OneShotJob): Promise<void> => {
  const envArgs = Object.entries(job.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const result = await $`docker run --rm --network ${network} ${envArgs} ${job.image} ${job.cmd}`
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `migrate job ${job.image} exited with ${result.exitCode}:\n${result.stdout.toString()}\n${result.stderr.toString()}`,
    );
  }
};

/** Run SQL inside the postgres container as `supabase_admin`. */
export const execSql = async (container: PostgresContainer, sql: string): Promise<string> => {
  const result =
    await $`docker exec -i -e PGPASSWORD=postgres ${container.name} psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -tA < ${new Response(sql)}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(
      `psql failed:\n${result.stderr.toString()}\nwhile executing:\n${sql.slice(0, 2000)}`,
    );
  }
  return result.stdout.toString();
};

/**
 * Apply a bundle SQL file with the container's own psql (statement-splitting
 * runner, matching client/server major). No `--single-transaction`: files may
 * contain non-transactional units.
 */
export const applySqlFile = async (container: PostgresContainer, path: string): Promise<void> => {
  const result =
    await $`docker exec -i -e PGPASSWORD=postgres ${container.name} psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -f - < ${Bun.file(path)}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`applying ${path} failed:\n${result.stderr.toString()}`);
  }
};

/** Byte-exact dump of migration bookkeeping/seed rows. */
export const dumpTrackingTables = async (
  container: PostgresContainer,
  tables: ReadonlyArray<string>,
): Promise<string> => {
  const tableArgs = tables.flatMap((table) => ["-t", table]);
  const result =
    await $`docker exec -e PGPASSWORD=postgres ${container.name} pg_dump -U supabase_admin -h 127.0.0.1 -d postgres --data-only --inserts ${tableArgs}`
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`pg_dump failed:\n${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};
