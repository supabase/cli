import type { ServiceDef } from "@supabase/process-compose";
import { dockerUsesHostNetwork } from "../Platform.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

interface DockerAnalyticsOptions {
  readonly image: string;
  readonly apiPort: number;
  readonly hostPort: number;
  readonly listenPort: number;
  readonly nodeHost: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly apiKey: string;
  readonly backend: "postgres" | "bigquery";
  readonly networkArgs: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

const ANALYTICS_CONTAINER_PORT = 4000;

export const analyticsDockerRuntimeNetwork = (
  os: string,
  hostPort: number,
  serviceHost: string,
): { readonly listenPort: number; readonly nodeHost: string } =>
  dockerUsesHostNetwork(os)
    ? { listenPort: hostPort, nodeHost: serviceHost }
    : { listenPort: ANALYTICS_CONTAINER_PORT, nodeHost: "0.0.0.0" };

const analyticsHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/health",
    scheme: "http",
  },
  initialDelaySeconds: 10,
  periodSeconds: 1,
  failureThreshold: 60,
});

export const makeAnalyticsServiceDocker = (opts: DockerAnalyticsOptions): ServiceDef => {
  const env: Record<string, string> = {
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
    containerName: `supabase-analytics-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
    entrypoint: "sh",
    cmd: [
      "-c",
      `cat <<'EOF' > /tmp/run.sh && sh /tmp/run.sh
echo "[analytics-startup] backend=${opts.backend} port=${opts.listenPort} node_host=${opts.nodeHost} db=${opts.dbHost}:${opts.dbPort}"
./logflare eval Logflare.Release.migrate
echo "[analytics-startup] migrate_exit=$?"
./logflare start --sname logflare
EOF
`,
    ],
    env,
    dependsOn: opts.dependencies,
    healthCheck: analyticsHealthCheck(opts.hostPort),
  });
};
