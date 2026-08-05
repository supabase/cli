import type { ServiceDef } from "@supabase/process-compose";
import { dockerPortMapArgs } from "../Platform.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";
import type { AnalyticsGcpConfig } from "../StackConfig.ts";

interface DockerAnalyticsOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly hostPort: number;
  readonly platformOs: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly apiKey: string;
  readonly backend: "postgres" | "bigquery";
  readonly gcp?: AnalyticsGcpConfig;
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
    env.GOOGLE_PROJECT_ID = opts.gcp?.projectId ?? "local";
    env.GOOGLE_PROJECT_NUMBER = opts.gcp?.projectNumber ?? "0";
  }

  return dockerRunService({
    name: "analytics",
    apiPort: opts.apiPort,
    image: opts.image,
    networkArgs: dockerPortMapArgs(opts.platformOs, [
      { host: opts.hostPort, container: ANALYTICS_CONTAINER_PORT },
    ]),
    volumes:
      opts.backend === "bigquery" && opts.gcp !== undefined
        ? [`${opts.gcp.credentialsPath}:/opt/app/rel/logflare/bin/gcloud.json:ro`]
        : [],
    entrypoint: "sh",
    cmd: [
      "-c",
      `cat <<'EOF' > /tmp/run.sh && sh /tmp/run.sh
./logflare eval Logflare.Release.migrate
./logflare start --sname logflare
EOF
`,
    ],
    env,
    dependencies: opts.dependencies,
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
};
