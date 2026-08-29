// oxlint-disable-next-line effecttsgo/node-builtin-import -- Native crash dumps are rooted in the caller-owned runtime directory.
import { join } from "node:path";
import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import {
  dockerRunService,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface AnalyticsServiceOptions {
  readonly hostPort: number;
  readonly dbPort: number;
  readonly apiKey: string;
  readonly backend: "postgres" | "bigquery";
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeAnalyticsOptions extends AnalyticsServiceOptions {
  readonly binPath: string;
  readonly runtimeRoot: string;
  /** A stack-unique, valid BEAM short node name for Logflare distribution. */
  readonly nodeName: string;
}

export interface NativeAnalyticsServiceBundle {
  /** Runs the bundled Logflare migration once before the server starts. */
  readonly migrate: ServiceDef;
  /** The public, long-running Logflare server. */
  readonly server: ServiceDef;
}

interface DockerAnalyticsOptions extends AnalyticsServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly platformOs: string;
  readonly dbHost: string;
}

const ANALYTICS_CONTAINER_PORT = 4000;

export const analyticsDockerRuntimeNetwork = (
  _os: string,
  _hostPort: number,
  _serviceHost: string,
): { readonly listenPort: number; readonly nodeHost: string } => ({
  listenPort: ANALYTICS_CONTAINER_PORT,
  nodeHost: "0.0.0.0",
});

const analyticsHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http",
  },
  ...stackHealthBudgets.analytics,
});

const analyticsEnv = (
  opts: AnalyticsServiceOptions & {
    readonly dbHost: string;
    readonly listenPort: number;
    readonly nodeHost: "127.0.0.1" | "0.0.0.0";
    readonly runtimeRoot?: string;
  },
): Record<string, string> => ({
  PORT: String(opts.listenPort),
  PHX_HTTP_PORT: String(opts.listenPort),
  DB_DATABASE: "_supabase",
  DB_HOSTNAME: opts.dbHost,
  DB_PORT: String(opts.dbPort),
  DB_SCHEMA: "_analytics",
  DB_USERNAME: "postgres",
  DB_PASSWORD: "postgres",
  LOGFLARE_MIN_CLUSTER_SIZE: "1",
  LOGFLARE_SINGLE_TENANT: "true",
  LOGFLARE_SUPABASE_MODE: "true",
  LOGFLARE_PRIVATE_ACCESS_TOKEN: opts.apiKey,
  LOGFLARE_LOG_LEVEL: "warn",
  LOGFLARE_NODE_HOST: opts.nodeHost,
  LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
  RELEASE_COOKIE: "cookie",
  ...(opts.backend === "postgres"
    ? {
        POSTGRES_BACKEND_URL: `postgresql://postgres:postgres@${opts.dbHost}:${opts.dbPort}/_supabase`,
        POSTGRES_BACKEND_SCHEMA: "_analytics",
      }
    : {
        GOOGLE_DATASET_ID_APPEND: "_prod",
        GOOGLE_PROJECT_ID: "local",
        GOOGLE_PROJECT_NUMBER: "0",
      }),
  ...(opts.runtimeRoot === undefined
    ? {}
    : {
        ELIXIR_ERL_OPTIONS: "+S 1:1 +SDio 1 +sbwt none +sbwtdcpu none +sbwtdio none",
        DB_POOL_SIZE: "2",
        LOGFLARE_PUBSUB_POOL_SIZE: "2",
        ERL_CRASH_DUMP: join(opts.runtimeRoot, "analytics", "erl_crash.dump"),
      }),
});

export const makeAnalyticsServiceDocker = (opts: DockerAnalyticsOptions): ServiceDef => {
  const runtimeNetwork = analyticsDockerRuntimeNetwork(opts.platformOs, opts.hostPort, opts.dbHost);
  const env = analyticsEnv({
    ...opts,
    listenPort: runtimeNetwork.listenPort,
    nodeHost: "0.0.0.0",
    runtimeRoot: undefined,
  });

  return dockerRunService({
    runtime: opts.runtime,
    name: "analytics",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerPortMapArgs(opts.platformOs, [
      { host: opts.hostPort, container: ANALYTICS_CONTAINER_PORT },
    ]),
    env,
    dependencies: opts.dependencies,
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
};

export const makeAnalyticsServicesNative = (
  opts: NativeAnalyticsOptions,
): NativeAnalyticsServiceBundle => {
  const env = analyticsEnv({
    ...opts,
    dbHost: "127.0.0.1",
    listenPort: opts.hostPort,
    nodeHost: "127.0.0.1",
    runtimeRoot: opts.runtimeRoot,
  });
  const migrate = nativeRunService({
    name: "analytics-migrate",
    command: `${opts.binPath}/bin/logflare`,
    args: ["eval", "Logflare.Release.migrate"],
    env,
    dependencies: opts.dependencies,
    restart: "no",
  });
  const server = nativeRunService({
    name: "analytics",
    command: `${opts.binPath}/bin/logflare`,
    args: ["start", "--sname", opts.nodeName],
    env,
    dependencies: [{ service: migrate.name, condition: "completed" }],
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
  return { migrate, server };
};
