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
}

export interface NativeAnalyticsServiceBundle {
  /** Runs the bundled Logflare migration once before the server starts. */
  readonly migrate: ServiceDef;
  /** Creates the local single-tenant Logflare records after migrations complete. */
  readonly seed: ServiceDef;
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

/** Starts Logflare and waits for its single-tenant startup task to finish. */
const ANALYTICS_SEED_SCRIPT = `{:ok, _} = Application.ensure_all_started(:logflare)
startup_task =
  Supervisor.which_children(Logflare.Supervisor)
  |> Enum.find(fn
    {Task, pid, :worker, _modules} when is_pid(pid) -> true
    _ -> false
  end)

case startup_task do
  {Task, pid, :worker, _modules} ->
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, :normal} -> :ok
      {:DOWN, ^ref, :process, ^pid, reason} ->
        raise "Logflare startup task failed: #{inspect(reason)}"
    after
      120_000 ->
        Process.demonitor(ref, [:flush])
        raise "Timed out waiting for Logflare startup task"
    end

  nil ->
    :ok
end

status = Logflare.SingleTenant.supabase_mode_status()

if status |> Map.values() |> Enum.all?(&(&1 == :ok)) do
  :ok
else
  raise "Logflare single-tenant bootstrap incomplete: #{inspect(status)}"
end`;

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
    readonly releaseCookie?: string;
  },
): Record<string, string> => ({
  PORT: String(opts.listenPort),
  PHX_HTTP_PORT: String(opts.listenPort),
  PHX_HTTP_IP: opts.nodeHost,
  DB_DATABASE: "_supabase",
  DB_HOSTNAME: opts.dbHost,
  DB_PORT: String(opts.dbPort),
  DB_SCHEMA: "_analytics",
  DB_USERNAME: "postgres",
  DB_PASSWORD: "postgres",
  LOGFLARE_MIN_CLUSTER_SIZE: "1",
  LOGFLARE_SINGLE_TENANT: "true",
  LOGFLARE_SUPABASE_MODE: "true",
  LOGFLARE_PUBLIC_ACCESS_TOKEN: `${opts.apiKey}-public`,
  LOGFLARE_PRIVATE_ACCESS_TOKEN: opts.apiKey,
  LOGFLARE_LOG_LEVEL: "warn",
  LOGFLARE_NODE_HOST: opts.nodeHost,
  LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
  ...(opts.releaseCookie === undefined ? {} : { RELEASE_COOKIE: opts.releaseCookie }),
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
        RELEASE_DISTRIBUTION: "none",
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
    releaseCookie: "cookie",
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
  const seed = nativeRunService({
    name: "analytics-seed",
    command: `${opts.binPath}/bin/logflare`,
    args: ["eval", ANALYTICS_SEED_SCRIPT],
    // The bootstrap starts Logflare to run its startup task but must not claim
    // the public server port before the long-running process starts.
    env: {
      ...env,
      PORT: "0",
      PHX_HTTP_PORT: "0",
      LOGFLARE_SINGLE_TENANT: "true",
      LOGFLARE_SUPABASE_MODE: "true",
    },
    dependencies: [{ service: migrate.name, condition: "completed" }],
    restart: "no",
  });
  const server = nativeRunService({
    name: "analytics",
    command: `${opts.binPath}/bin/logflare`,
    args: ["start"],
    env,
    dependencies: [{ service: seed.name, condition: "completed" }],
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
  return { migrate, seed, server };
};
