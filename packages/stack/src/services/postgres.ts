import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import { dockerContainerName, type StackIdentity } from "../StackIdentity.ts";
import { removePathOnOrphanCleanup } from "./docker-cleanup.ts";
import { stackHealthBudgets } from "./health-budgets.ts";
import {
  dockerExecHealthCheck,
  dockerRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";

interface PostgresServiceOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly cleanupDataDirOnExit?: boolean;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

interface NativePostgresOptions extends PostgresServiceOptions {
  readonly binPath: string;
}

interface DockerPostgresOptions extends PostgresServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly platformOs: string;
  readonly identity: StackIdentity;
  readonly cleanupDataDirOnExit?: boolean;
}

const postgresEnv = (opts: NativePostgresOptions): Record<string, string> => ({
  PGDATA: opts.dataDir,
  POSTGRES_PASSWORD: "postgres",
  DYLD_LIBRARY_PATH: `${opts.binPath}/lib`,
  LD_LIBRARY_PATH: `${opts.binPath}/lib`,
  TZDIR: "/var/db/timezone/zoneinfo",
});

const NATIVE_POSTGRES_RUNTIME_ARGS = [
  "-c",
  "wal_level=logical",
  "-c",
  "max_wal_senders=5",
  "-c",
  "max_replication_slots=5",
] as const;

const orphanCleanup = (opts: PostgresServiceOptions) =>
  opts.cleanupDataDirOnExit ? removePathOnOrphanCleanup(opts.dataDir) : [];

const postgresHealthCheck = (binPath: string, port: number) => ({
  probe: {
    _tag: "Exec" as const,
    command: `${binPath}/bin/pg_isready`,
    args: ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"],
    env: {
      DYLD_LIBRARY_PATH: `${binPath}/lib`,
      LD_LIBRARY_PATH: `${binPath}/lib`,
    },
  },
  ...stackHealthBudgets.postgresNative,
});

/**
 * Docker postgres health check using pg_isready inside the container.
 *
 * TCP alone is insufficient because the supabase/postgres image accepts TCP
 * connections during its init phase (running init scripts) but drops real
 * queries with "unexpected EOF". We use `docker exec` to run pg_isready
 * inside the container, which verifies postgres is accepting commands.
 */
const postgresDockerHealthCheck = (
  runtime: DockerPostgresOptions["runtime"],
  containerName: string,
  port: number,
) =>
  dockerExecHealthCheck(
    runtime,
    containerName,
    "pg_isready",
    ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"],
    {
      ...stackHealthBudgets.postgresDocker,
    },
  );

export const makePostgresService = (opts: NativePostgresOptions): ServiceDef => {
  const initScript = `${opts.binPath}/share/supabase-cli/bin/supabase-postgres-init.sh`;

  return {
    name: "postgres",
    command: "bash",
    args: [initScript, "-p", String(opts.port), ...NATIVE_POSTGRES_RUNTIME_ARGS],
    env: postgresEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: postgresHealthCheck(opts.binPath, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    supervision: { orphanCleanup: orphanCleanup(opts) },
    restart: "unless-stopped",
  };
};

export const makePostgresServiceDocker = (opts: DockerPostgresOptions): ServiceDef => {
  const containerName = dockerContainerName("postgres", opts.identity.key);
  return dockerRunService({
    runtime: opts.runtime,
    name: "postgres",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:/var/lib/postgresql/data`],
    env: { POSTGRES_PASSWORD: "postgres" },
    cmd: ["-p", String(opts.port)],
    dependencies: opts.dependencies,
    healthCheck: postgresDockerHealthCheck(opts.runtime, containerName, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    orphanCleanup: orphanCleanup(opts),
  });
};
