import type { ServiceDef } from "@supabase/process-compose";
import { dockerServiceCleanup, dockerServiceOrphanCleanup } from "./docker-cleanup.ts";

interface PostgrestServiceOptions {
  readonly dbPort: number;
  readonly port: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly jwtSecret: string;
}

interface NativePostgrestOptions extends PostgrestServiceOptions {
  readonly binPath: string;
}

interface DockerPostgrestOptions extends PostgrestServiceOptions {
  readonly image: string;
  readonly dbHost: string;
  readonly networkArgs: readonly string[];
  readonly adminPort: number;
  readonly apiPort: number;
}

const postgrestEnv = (
  opts: PostgrestServiceOptions,
  dbHost = "127.0.0.1",
): Record<string, string> => ({
  PGRST_DB_URI: `postgresql://authenticator:postgres@${dbHost}:${opts.dbPort}/postgres`,
  PGRST_DB_SCHEMAS: opts.schemas.join(","),
  PGRST_DB_EXTRA_SEARCH_PATH: opts.extraSearchPath.join(","),
  PGRST_DB_ANON_ROLE: "anon",
  PGRST_JWT_SECRET: opts.jwtSecret,
  PGRST_DB_MAX_ROWS: String(opts.maxRows),
  PGRST_SERVER_PORT: String(opts.port),
});

const postgrestHealthCheck = (port: number) => ({
  probe: {
    _tag: "Http" as const,
    host: "127.0.0.1",
    port,
    path: "/",
    scheme: "http" as const,
  },
  periodSeconds: 0.5,
  failureThreshold: 20,
});

const postgrestDependencies = [{ service: "postgres-init", condition: "completed" as const }];

export const makePostgrestService = (opts: NativePostgrestOptions): ServiceDef => ({
  name: "postgrest",
  command: `${opts.binPath}/postgrest`,
  env: postgrestEnv(opts),
  dependencies: postgrestDependencies,
  healthCheck: postgrestHealthCheck(opts.port),
  supervision: {},
  restart: "unless-stopped",
});

export const makePostgrestServiceDocker = (opts: DockerPostgrestOptions): ServiceDef => {
  const env = {
    ...postgrestEnv(opts, opts.dbHost),
    PGRST_ADMIN_SERVER_PORT: String(opts.adminPort),
  };
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const containerName = `supabase-postgrest-${opts.apiPort}`;

  return {
    name: "postgrest",
    command: "docker",
    args: ["run", "--rm", "--name", containerName, ...opts.networkArgs, ...envArgs, opts.image],
    dependencies: postgrestDependencies,
    healthCheck: postgrestHealthCheck(opts.port),
    cleanup: dockerServiceCleanup(containerName),
    supervision: { orphanCleanup: dockerServiceOrphanCleanup(containerName) },
    restart: "unless-stopped",
  };
};
