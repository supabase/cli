import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface DockerAnalyticsOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly hostPort: number;
  readonly platformOs: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly apiKey: string;
  readonly backend: "postgres" | "bigquery";
  readonly dependencies: ReadonlyArray<ServiceDependency>;
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

export const makeAnalyticsServiceDocker = (opts: DockerAnalyticsOptions): ServiceDef => {
  const runtimeNetwork = analyticsDockerRuntimeNetwork(opts.platformOs, opts.hostPort, opts.dbHost);
  const env: Record<string, string> = {
    PORT: String(runtimeNetwork.listenPort),
    PHX_HTTP_PORT: String(runtimeNetwork.listenPort),
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
    LOGFLARE_NODE_HOST: runtimeNetwork.nodeHost,
    LOGFLARE_FEATURE_FLAG_OVERRIDE: "'multibackend=true'",
    RELEASE_COOKIE: "cookie",
  };

  if (opts.backend === "postgres") {
    env.POSTGRES_BACKEND_URL = `postgresql://postgres:postgres@${opts.dbHost}:${opts.dbPort}/_supabase`;
    env.POSTGRES_BACKEND_SCHEMA = "_analytics";
  } else {
    env.GOOGLE_DATASET_ID_APPEND = "_prod";
    env.GOOGLE_PROJECT_ID = "local";
    env.GOOGLE_PROJECT_NUMBER = "0";
  }

  return dockerRunService({
    name: "analytics",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerPortMapArgs(opts.platformOs, [
      { host: opts.hostPort, container: ANALYTICS_CONTAINER_PORT },
    ]),
    entrypoint: "sh",
    cmd: [
      "-c",
      // migrate && start: a failed migrate exits the container and the
      // unless-stopped restart retries until the db is ready (supabase/cli#6088).
      `cat <<'EOF' > /tmp/run.sh && sh /tmp/run.sh
./logflare eval Logflare.Release.migrate &&
./logflare start --sname logflare
EOF
`,
    ],
    env,
    dependencies: opts.dependencies,
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
};
