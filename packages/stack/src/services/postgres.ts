import { mkdirSync, writeFileSync } from "node:fs";
import type { ServiceDef } from "@supabase/process-compose";
import {
  dockerServiceCleanup,
  dockerServiceOrphanCleanup,
  removePathOnOrphanCleanup,
} from "./docker-cleanup.ts";

interface PostgresServiceOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly cleanupDataDirOnExit?: boolean;
}

interface NativePostgresOptions extends PostgresServiceOptions {
  readonly binPath: string;
  /** When true, patches postgres to listen on all interfaces so Docker containers can connect. */
  readonly dockerAccessible?: boolean;
}

interface DockerPostgresOptions extends PostgresServiceOptions {
  readonly image: string;
  readonly networkArgs: readonly string[];
  readonly jwtSecret: string;
  readonly jwtExpiry: number;
  readonly apiPort: number;
  readonly cleanupDataDirOnExit?: boolean;
}

const postgresEnv = (opts: NativePostgresOptions): Record<string, string> => ({
  PGDATA: opts.dataDir,
  POSTGRES_PASSWORD: "postgres",
  DYLD_LIBRARY_PATH: `${opts.binPath}/lib`,
  LD_LIBRARY_PATH: `${opts.binPath}/lib`,
  TZDIR: "/var/db/timezone/zoneinfo",
});

const postgresDockerEnv = (opts: DockerPostgresOptions): Record<string, string> => ({
  POSTGRES_PASSWORD: "postgres",
  JWT_SECRET: opts.jwtSecret,
  JWT_EXP: String(opts.jwtExpiry),
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

const DOCKER_POSTGRES_SCHEMA_SQL = `\\set pgpass \`echo "$PGPASSWORD"\`
\\set jwt_secret \`echo "$JWT_SECRET"\`
\\set jwt_exp \`echo "$JWT_EXP"\`
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
ALTER USER postgres WITH PASSWORD :'pgpass';
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_replication_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_read_only_user WITH PASSWORD :'pgpass';
create schema if not exists _realtime;
alter schema _realtime owner to postgres;`;

const dockerPostgresEntrypoint = (port: number) =>
  `cat <<'EOF' > /etc/postgresql.schema.sql && exec docker-entrypoint.sh postgres -D /etc/postgresql -p ${port}
${DOCKER_POSTGRES_SCHEMA_SQL}
EOF`;

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
  periodSeconds: 0.5,
  failureThreshold: 30,
});

/**
 * Docker postgres health check using pg_isready inside the container.
 *
 * TCP alone is insufficient because the supabase/postgres image accepts TCP
 * connections during its init phase (running init scripts) but drops real
 * queries with "unexpected EOF". We use `docker exec` to run pg_isready
 * inside the container, which verifies postgres is accepting commands.
 */
const postgresDockerHealthCheck = (containerName: string, port: number) => ({
  probe: {
    _tag: "Exec" as const,
    command: "docker",
    args: ["exec", containerName, "pg_isready", "-p", String(port), "-U", "postgres"],
  },
  initialDelaySeconds: 1,
  periodSeconds: 0.5,
  failureThreshold: 30,
});

export const makePostgresService = (opts: NativePostgresOptions): ServiceDef => {
  const initScript = `${opts.binPath}/share/supabase-cli/bin/supabase-postgres-init.sh`;

  if (opts.dockerAccessible) {
    // On macOS/Windows, Docker containers connect via host.docker.internal which
    // resolves to a gateway IP (not 127.0.0.1). We create a per-run pg_hba.conf
    // that allows connections from any IP, and use postgres -c flags to override
    // listen_addresses and hba_file. This avoids mutating the shared binary cache.
    const customHbaPath = `${opts.dataDir}_pg_hba_docker.conf`;
    mkdirSync(opts.dataDir, { recursive: true });
    writeFileSync(
      customHbaPath,
      [
        "local   all             all                                     scram-sha-256",
        "host    all             all             127.0.0.1/32            scram-sha-256",
        "host    all             all             ::1/128                 scram-sha-256",
        "host    all             all             0.0.0.0/0               scram-sha-256",
        "",
      ].join("\n"),
      "utf8",
    );

    return {
      name: "postgres",
      command: "bash",
      args: [
        initScript,
        "-p",
        String(opts.port),
        ...NATIVE_POSTGRES_RUNTIME_ARGS,
        "-c",
        "listen_addresses=*",
        "-c",
        `hba_file=${customHbaPath}`,
      ],
      env: postgresEnv(opts),
      healthCheck: postgresHealthCheck(opts.binPath, opts.port),
      shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
      supervision: {
        orphanCleanup: [
          ...orphanCleanup(opts),
          ...removePathOnOrphanCleanup(customHbaPath, { recursive: false }),
        ],
      },
      restart: "unless-stopped",
    };
  }

  return {
    name: "postgres",
    command: "bash",
    args: [initScript, "-p", String(opts.port), ...NATIVE_POSTGRES_RUNTIME_ARGS],
    env: postgresEnv(opts),
    healthCheck: postgresHealthCheck(opts.binPath, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    supervision: { orphanCleanup: orphanCleanup(opts) },
    restart: "unless-stopped",
  };
};

export const makePostgresServiceDocker = (opts: DockerPostgresOptions): ServiceDef => {
  const env = postgresDockerEnv(opts);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const containerName = `supabase-postgres-${opts.apiPort}`;
  const dockerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    ...opts.networkArgs,
    "-v",
    `${opts.dataDir}:/var/lib/postgresql/data`,
    ...envArgs,
    "--entrypoint",
    "sh",
    opts.image,
    "-c",
    dockerPostgresEntrypoint(opts.port),
  ];
  return {
    name: "postgres",
    command: "docker",
    args: dockerArgs,
    healthCheck: postgresDockerHealthCheck(containerName, opts.port),
    shutdown: { signal: "SIGTERM", timeoutSeconds: 10 },
    cleanup: dockerServiceCleanup(containerName),
    supervision: {
      orphanCleanup: [...dockerServiceOrphanCleanup(containerName), ...orphanCleanup(opts)],
    },
    restart: "unless-stopped",
  };
};
