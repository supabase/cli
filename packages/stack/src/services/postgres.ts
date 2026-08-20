import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import { dockerContainerName, type StackIdentity } from "../StackIdentity.ts";
import { removePathOnOrphanCleanup } from "./docker-cleanup.ts";
import { stackHealthBudgets } from "./health-budgets.ts";
import {
  dockerExecHealthCheck,
  dockerRunService,
  hostUserForLinuxDocker,
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
 * Docker postgres health check using the final postgres process and pg_isready
 * inside the container.
 *
 * The supabase/postgres image briefly accepts connections while its entrypoint
 * runs initialization. During that phase PID 1 is still the shell and the
 * temporary server is stopped before the final postgres process starts. Gate
 * readiness on the final Postgres process name and pg_isready so dependents
 * never race that handoff. `/proc/1/exe` is intentionally avoided because
 * Linux container hardening can make that symlink unreadable across users.
 */
const postgresDockerHealthCheck = (
  runtime: DockerPostgresOptions["runtime"],
  containerName: string,
  port: number,
) =>
  dockerExecHealthCheck(
    runtime,
    containerName,
    "sh",
    [
      "-ec",
      `case "$(cat /proc/1/comm)" in postgres|.postgres-wrapp) pg_isready -h 127.0.0.1 -p ${port} -U postgres ;; *) exit 1 ;; esac`,
    ],
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
  const hostUser = hostUserForLinuxDocker(opts.runtime, opts.platformOs);
  const [hostUid, hostGid] = hostUser?.split(":") ?? [];
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
  const runEntrypoint = (args: string): string =>
    hostUser === undefined
      ? `exec /usr/local/bin/entry.sh ${args}`
      : `exec busybox su -s /usr/bin/sh supabase_cli -c "exec /usr/local/bin/entry.sh ${args}"`;
  // initdb requires the effective uid to resolve through /etc/passwd, while
  // the image init script chmods its key helper. Perform only that image setup
  // as root, then drop to the host uid before touching the bind-mounted data.
  const hostUserSetup =
    hostUser === undefined
      ? ""
      : `printf 'supabase_cli:x:${hostUid}:${hostGid}:Supabase CLI:/tmp:/usr/bin/sh\\n' >> /etc/passwd
busybox chown ${hostUid}:${hostGid} /opt/postgres/share/supabase-cli/config/pgsodium_getkey.sh
`;
  const command = `${hostUserSetup}if [ -s /var/lib/postgresql/data/PG_VERSION ]; then
  cp /var/lib/postgresql/data/pg_hba.conf /tmp/supabase-cli-pg_hba.conf
  printf '\\nhost all all all scram-sha-256\\n' >> /tmp/supabase-cli-pg_hba.conf
  ${hostUser === undefined ? "" : `busybox chown ${hostUid}:${hostGid} /tmp/supabase-cli-pg_hba.conf`}
  ${runEntrypoint(`-c hba_file=/tmp/supabase-cli-pg_hba.conf ${runtimeArgs.join(" ")}`)}
else
  ${runEntrypoint(runtimeArgs.join(" "))}
fi`;

  return dockerRunService({
    runtime: opts.runtime,
    name: "postgres",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:/var/lib/postgresql/data`],
    env: { POSTGRES_PASSWORD: "postgres" },
    user: hostUser === undefined ? undefined : "0",
    entrypoint: "/usr/bin/sh",
    cmd: ["-c", command],
    dependencies: opts.dependencies,
    healthCheck: postgresDockerHealthCheck(opts.runtime, containerName, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    orphanCleanup: orphanCleanup(opts),
  });
};
