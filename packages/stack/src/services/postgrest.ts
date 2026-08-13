import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import { stackHealthBudgets } from "./health-budgets.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

interface PostgrestServiceOptions {
  readonly dbPort: number;
  readonly port: number;
  readonly schemas: ReadonlyArray<string>;
  readonly extraSearchPath: ReadonlyArray<string>;
  readonly maxRows: number;
  readonly jwtSecret: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

interface NativePostgrestOptions extends PostgrestServiceOptions {
  readonly binPath: string;
}

interface DockerPostgrestOptions extends PostgrestServiceOptions {
  readonly image: string;
  readonly dbHost: string;
  readonly platformOs: string;
  readonly adminPort: number;
  readonly identity: StackIdentity;
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
  ...stackHealthBudgets.postgrest,
});

export const makePostgrestService = (opts: NativePostgrestOptions): ServiceDef => ({
  name: "postgrest",
  command: `${opts.binPath}/postgrest`,
  env: postgrestEnv(opts),
  dependencies: opts.dependencies,
  healthCheck: postgrestHealthCheck(opts.port),
  supervision: {},
  restart: "unless-stopped",
});

export const makePostgrestServiceDocker = (opts: DockerPostgrestOptions): ServiceDef => {
  const env = {
    ...postgrestEnv(opts, opts.dbHost),
    PGRST_ADMIN_SERVER_PORT: String(opts.adminPort),
  };
  return dockerRunService({
    name: "postgrest",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port, opts.adminPort]),
    env,
    dependencies: opts.dependencies,
    healthCheck: postgrestHealthCheck(opts.port),
  });
};
