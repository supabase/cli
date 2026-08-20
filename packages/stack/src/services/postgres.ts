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
  "listen_addresses=127.0.0.1",
  "-c",
  "wal_level=logical",
  "-c",
  "max_wal_senders=5",
  "-c",
  "max_replication_slots=5",
] as const;

const postgresGetKeyScript = (binPath: string): string =>
  `${binPath}/share/supabase-cli/config/pgsodium_getkey.sh`;

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
  const getKeyScript = postgresGetKeyScript(opts.binPath);

  return {
    name: "postgres",
    command: "bash",
    args: [
      initScript,
      "-p",
      String(opts.port),
      ...NATIVE_POSTGRES_RUNTIME_ARGS,
      "-c",
      `pgsodium.getkey_script=${getKeyScript}`,
      "-c",
      `vault.getkey_script=${getKeyScript}`,
    ],
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
  const runtimeArgs = [
    "-p",
    String(opts.port),
    "-c",
    "listen_addresses=*",
    "-c",
    "pgsodium.getkey_script=/opt/postgres/share/supabase-cli/config/pgsodium_getkey.sh",
    "-c",
    "vault.getkey_script=/opt/postgres/share/supabase-cli/config/pgsodium_getkey.sh",
  ] as const;

  // Native initialization permits only loopback clients. When reusing that
  // data directory in Docker, route through a temporary HBA copy that adds the
  // container network rule without mutating the persisted native config.
  const command = `if [ -s /var/lib/postgresql/data/PG_VERSION ]; then
  cp /var/lib/postgresql/data/pg_hba.conf /tmp/supabase-cli-pg_hba.conf
  printf '\\nhost all all all scram-sha-256\\n' >> /tmp/supabase-cli-pg_hba.conf
  exec /usr/local/bin/entry.sh -c hba_file=/tmp/supabase-cli-pg_hba.conf ${runtimeArgs.join(" ")}
else
  exec /usr/local/bin/entry.sh ${runtimeArgs.join(" ")}
fi`;

  return dockerRunService({
    runtime: opts.runtime,
    name: "postgres",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:/var/lib/postgresql/data`],
    env: { POSTGRES_PASSWORD: "postgres" },
    entrypoint: "/usr/bin/sh",
    cmd: ["-c", command],
    dependencies: opts.dependencies,
    healthCheck: postgresDockerHealthCheck(opts.runtime, containerName, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    orphanCleanup: orphanCleanup(opts),
  });
};
