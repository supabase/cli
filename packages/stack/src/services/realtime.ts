import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  hostHttpHealthCheck,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface RealtimeServiceOptions {
  readonly port: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly jwtSecret: string;
  readonly jwtJwks: string;
  readonly tenantId: string;
  readonly encryptionKey: string;
  readonly secretKeyBase: string;
  readonly maxHeaderLength: number;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeRealtimeOptions extends Omit<RealtimeServiceOptions, "dbHost"> {
  readonly binPath: string;
  /** Stack-unique Erlang short name and cookie for host-level distribution. */
  readonly nodeName: string;
  readonly releaseCookie: string;
}

export interface NativeRealtimeServiceBundle {
  /** Runs the bundled database migration once before the application starts. */
  readonly migrate: ServiceDef;
  /** Seeds the self-hosted tenant once after migrations complete. */
  readonly seed: ServiceDef;
  /** The public, long-running Realtime service. */
  readonly server: ServiceDef;
}

interface DockerRealtimeOptions extends RealtimeServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
}

const realtimeEnv = (
  opts: Omit<RealtimeServiceOptions, "dbHost"> & {
    readonly dbHost?: string;
    readonly nodeName?: string;
    readonly releaseCookie?: string;
  },
): Record<string, string> => ({
  PORT: String(opts.port),
  DB_HOST: opts.dbHost ?? "127.0.0.1",
  DB_PORT: String(opts.dbPort),
  DB_USER: "postgres",
  DB_PASSWORD: "postgres",
  DB_NAME: "postgres",
  DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
  DB_ENC_KEY: opts.encryptionKey,
  API_JWT_SECRET: opts.jwtSecret,
  API_JWT_JWKS: opts.jwtJwks,
  METRICS_JWT_SECRET: opts.jwtSecret,
  APP_NAME: "realtime",
  SECRET_KEY_BASE: opts.secretKeyBase,
  ERL_AFLAGS: "-proto_dist inet_tcp",
  DNS_NODES: "",
  RLIMIT_NOFILE: "",
  SEED_SELF_HOST: "true",
  RUN_JANITOR: "true",
  MAX_HEADER_LENGTH: String(opts.maxHeaderLength),
  ...(opts.nodeName === undefined || opts.releaseCookie === undefined
    ? {}
    : {
        NODE_NAME: opts.nodeName,
        NODE_IP: "127.0.0.1",
        RELEASE_NODE: `${opts.nodeName}@127.0.0.1`,
        RELEASE_COOKIE: opts.releaseCookie,
      }),
});

const realtimeDockerHealthCheck = (port: number, tenantId: string): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Exec",
    command: "curl",
    args: [
      "-sSfL",
      "--head",
      "-o",
      "/dev/null",
      "-H",
      `Host:${tenantId}`,
      `http://127.0.0.1:${port}/api/ping`,
    ],
  },
  ...stackHealthBudgets.realtime,
});

const realtimeNativeHealthCheck = (port: number, tenantId: string): ServiceDef["healthCheck"] =>
  hostHttpHealthCheck(port, "/api/ping", {
    ...stackHealthBudgets.realtime,
    headers: { Host: tenantId },
  });

export const makeRealtimeServiceDocker = (opts: DockerRealtimeOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "realtime",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    env: realtimeEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: realtimeDockerHealthCheck(opts.port, opts.tenantId),
  });

export const makeRealtimeServicesNative = (
  opts: NativeRealtimeOptions,
): NativeRealtimeServiceBundle => {
  const env = realtimeEnv(opts);
  const migrate = nativeRunService({
    name: "realtime-migrate",
    command: `${opts.binPath}/bin/migrate`,
    env,
    dependencies: opts.dependencies,
    restart: "no",
  });
  const seed = nativeRunService({
    name: "realtime-seed",
    command: `${opts.binPath}/bin/realtime`,
    args: ["eval", "Realtime.Release.seeds(Realtime.Repo)"],
    env,
    dependencies: [{ service: migrate.name, condition: "completed" }],
    restart: "no",
  });
  const server = nativeRunService({
    name: "realtime",
    command: `${opts.binPath}/bin/server`,
    env,
    dependencies: [{ service: seed.name, condition: "completed" }],
    healthCheck: realtimeNativeHealthCheck(opts.port, opts.tenantId),
  });
  return { migrate, seed, server };
};
