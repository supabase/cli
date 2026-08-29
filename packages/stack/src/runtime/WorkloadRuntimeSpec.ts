import type { PersistedStackState } from "../state/StackState.ts";
import type { PlannedWorkload } from "../model/ExecutionPlan.ts";

/** Runtime-facing details which are deliberately private to each workload.
 *
 * Public listeners are owned by StackGateway.  These values describe the
 * process/container side only: executable arguments, environment, and the
 * loopback port used by the gateway after lazy activation.
 */
export interface WorkloadRuntimeSpec {
  readonly containerPort: number;
  readonly cwd: (state: PersistedStackState, workload: PlannedWorkload) => string;
  readonly privateEndpoint: (
    port: number,
  ) => Readonly<{ readonly host: string; readonly port: number }>;
  readonly args: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
  ) => ReadonlyArray<string>;
  readonly env: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
  ) => Readonly<Record<string, string>>;
  readonly containerArgs?: (
    state: PersistedStackState,
    workload: PlannedWorkload,
    port: number,
  ) => ReadonlyArray<string>;
  readonly readiness: Readonly<{ readonly protocol: "http" | "tcp"; readonly path?: string }>;
}

type WorkloadRuntimeSpecDefinition = Omit<WorkloadRuntimeSpec, "cwd" | "privateEndpoint"> &
  Partial<Pick<WorkloadRuntimeSpec, "cwd" | "privateEndpoint">>;

const defaultCwd = (state: PersistedStackState): string => state.identity.projectRoot;
const defaultPrivateEndpoint = (
  port: number,
): Readonly<{ readonly host: string; readonly port: number }> => ({
  host: "127.0.0.1",
  port,
});

const stringSetting = (state: PersistedStackState, capability: string, key: string): string => {
  const settings =
    state.definition === undefined
      ? undefined
      : Object.entries(state.definition.capabilities).find(([name]) => name === capability)?.[1]
          ?.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return "";
  const value = Object.fromEntries(Object.entries(settings))[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "slot" in value &&
    typeof value.slot === "string"
  )
    return state.secrets[value.slot]?.value ?? "";
  return "";
};

const secret = (state: PersistedStackState, slot: string): string =>
  state.secrets[slot]?.value ?? "";
const dbPort = (state: PersistedStackState): number =>
  state.ports.find((assignment) => assignment.field === "database")?.port ?? 5432;
const dbUrl = (state: PersistedStackState, role = "postgres"): string =>
  `postgresql://${role}:${secret(state, "secret:database.internal.password")}@127.0.0.1:${dbPort(state)}/postgres`;

const common = (workload: PlannedWorkload, port: number): Record<string, string> => ({
  SUPABASE_STACK_WORKLOAD: workload.id,
  SUPABASE_STACK_PRIVATE_PORT: String(port),
});

const functionsRoot = (state: PersistedStackState): string => {
  const settings = state.definition?.capabilities.functions.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings))
    return `${state.identity.projectRoot}/supabase/functions`;
  const value = Object.fromEntries(Object.entries(settings)).functions_root;
  return typeof value === "string" ? value : `${state.identity.projectRoot}/supabase/functions`;
};

const specs: Readonly<Record<string, WorkloadRuntimeSpecDefinition>> = {
  "database:database": {
    containerPort: 5432,
    args: (state, _workload, port) => ["-p", String(port), "-c", "listen_addresses=127.0.0.1"],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PGDATA: `${state.identity.projectRoot}/.supabase/db/data`,
      POSTGRES_PASSWORD: secret(state, "secret:database.internal.password"),
      TZDIR: "/var/db/timezone/zoneinfo",
    }),
    containerArgs: (_state, _workload, port) => ["-p", String(port), "-c", "listen_addresses=*"],
    readiness: { protocol: "tcp" },
  },
  "rest:rest": {
    containerPort: 3000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PGRST_DB_URI: dbUrl(state, "authenticator"),
      PGRST_DB_SCHEMAS: stringSetting(state, "rest", "schemas") || "public,graphql_public",
      PGRST_DB_EXTRA_SEARCH_PATH:
        stringSetting(state, "rest", "extra_search_path") || "public,extensions",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      PGRST_SERVER_PORT: String(port),
      PGRST_DB_MAX_ROWS: stringSetting(state, "rest", "max_rows") || "1000",
    }),
    readiness: { protocol: "http", path: "/" },
  },
  "auth:auth": {
    containerPort: 9999,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      GOTRUE_DB_DATABASE_URL: dbUrl(state, "supabase_auth_admin"),
      GOTRUE_DB_DRIVER: "postgres",
      GOTRUE_SITE_URL: stringSetting(state, "auth", "site_url") || "http://127.0.0.1",
      GOTRUE_JWT_SECRET: secret(state, "secret:auth.settings.jwt_secret"),
      GOTRUE_JWT_EXP: stringSetting(state, "auth", "jwt_expiry") || "3600",
      GOTRUE_JWT_AUD: "authenticated",
      GOTRUE_API_HOST: "127.0.0.1",
      GOTRUE_API_PORT: String(port),
      API_EXTERNAL_URL: stringSetting(state, "auth", "external_url") || "http://127.0.0.1",
    }),
    readiness: { protocol: "http", path: "/health" },
  },
  "realtime:realtime": {
    containerPort: 4000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PORT: String(port),
      DB_HOST: "127.0.0.1",
      DB_PORT: String(dbPort(state)),
      DB_USER: "postgres",
      DB_PASSWORD: secret(state, "secret:database.internal.password"),
      DB_NAME: "postgres",
      DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
      API_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      APP_NAME: "realtime",
      SEED_SELF_HOST: "true",
    }),
    readiness: { protocol: "http", path: "/api/ping" },
  },
  "storage:storage": {
    containerPort: 5000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PORT: String(port),
      ANON_KEY: secret(state, "secret:auth.settings.anon_key"),
      SERVICE_KEY: secret(state, "secret:auth.settings.service_role_key"),
      AUTH_JWT_SECRET: secret(state, "secret:auth.settings.jwt_secret"),
      DATABASE_URL: dbUrl(state, "supabase_storage_admin"),
      FILE_SIZE_LIMIT: stringSetting(state, "storage", "file_size_limit") || "50MiB",
      STORAGE_BACKEND: "file",
      FILE_STORAGE_BACKEND_PATH: "/var/lib/storage",
      STORAGE_FILE_BACKEND_PATH: "/var/lib/storage",
      ENABLE_IMAGE_TRANSFORMATION:
        stringSetting(state, "storage", "image_transformation") || "false",
      S3_PROTOCOL_ENABLED: stringSetting(state, "storage", "s3_protocol") || "true",
      S3_PROTOCOL_ACCESS_KEY_ID: "local",
      S3_PROTOCOL_ACCESS_KEY_SECRET: "local-secret",
    }),
    readiness: { protocol: "http", path: "/status" },
  },
  "storage:imgproxy": {
    containerPort: 8080,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      IMGPROXY_BIND: `127.0.0.1:${port}`,
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
    }),
    readiness: { protocol: "http", path: "/health" },
  },
  "functions:edge-runtime": {
    containerPort: 9000,
    cwd: functionsRoot,
    args: (state, _workload, port) => [
      "start",
      `--main-service=${functionsRoot(state)}`,
      `--port=${port}`,
      `--policy=${stringSetting(state, "functions", "edge_runtime") || "per_worker"}`,
    ],
    env: (state, workload, port) => ({
      ...common(workload, port),
      EDGE_RUNTIME_PORT: String(port),
      FUNCTIONS_ROOT: functionsRoot(state),
    }),
    containerArgs: (_state, _workload, port) => [
      "start",
      "--main-service=/workspace",
      `--port=${port}`,
    ],
    readiness: { protocol: "http", path: "/_internal/health" },
  },
  "studio:studio": {
    containerPort: 3000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      SUPABASE_URL: stringSetting(state, "studio", "api_url") || "http://127.0.0.1",
    }),
    readiness: { protocol: "http", path: "/api/platform/profile" },
  },
  "studio:pgmeta": {
    containerPort: 8080,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PG_META_PORT: String(port),
      PG_META_DB_HOST: "127.0.0.1",
      PG_META_DB_PORT: String(dbPort(state)),
      PG_META_DB_NAME: "postgres",
      PG_META_DB_USER: "postgres",
      PG_META_DB_PASSWORD: secret(state, "secret:database.internal.password"),
    }),
    readiness: { protocol: "http", path: "/health" },
  },
  "mail:mail": {
    containerPort: 8025,
    args: (_state, _workload, port) => ["--ui", `127.0.0.1:${port}`],
    env: (state, workload, port) => ({
      ...common(workload, port),
      MP_UI_BIND_ADDR: `127.0.0.1:${port}`,
      MP_SMTP_BIND_ADDR: "127.0.0.1:1025",
      MP_POP3_BIND_ADDR: "127.0.0.1:1110",
    }),
    readiness: { protocol: "http", path: "/readyz" },
  },
  "analytics:analytics": {
    containerPort: 4000,
    args: () => [],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PORT: String(port),
      PHX_HTTP_PORT: String(port),
      DB_HOSTNAME: "127.0.0.1",
      DB_PORT: String(dbPort(state)),
      DB_DATABASE: "_supabase",
      DB_USERNAME: "postgres",
      DB_PASSWORD: secret(state, "secret:database.internal.password"),
      LOGFLARE_SUPABASE_MODE: "true",
      LOGFLARE_SINGLE_TENANT: "true",
      LOGFLARE_PRIVATE_ACCESS_TOKEN: stringSetting(state, "analytics", "api_key"),
    }),
    readiness: { protocol: "http", path: "/health" },
  },
  "analytics:vector": {
    containerPort: 9001,
    args: (_state, _workload, _port) => [
      "--config",
      "/etc/vector/vector.yaml",
      "--watch-config",
      "false",
    ],
    env: (state, workload, port) => ({ ...common(workload, port), VECTOR_API_PORT: String(port) }),
    readiness: { protocol: "http", path: "/health" },
  },
  "pooler:pooler": {
    containerPort: 6543,
    args: () => ["start"],
    env: (state, workload, port) => ({
      ...common(workload, port),
      PORT: String(port),
      PROXY_PORT_TRANSACTION: String(port),
      DATABASE_URL: `ecto://postgres:${secret(state, "secret:database.internal.password")}@127.0.0.1:${dbPort(state)}/_supabase`,
      API_JWT_SECRET: secret(state, "secret:security.jwt.signing.secret"),
      REGION: "local",
      CLUSTER_POSTGRES: "true",
    }),
    readiness: { protocol: "tcp" },
  },
};

export const runtimeSpecFor = (workload: PlannedWorkload): WorkloadRuntimeSpec | undefined => {
  const spec = specs[workload.id];
  if (spec !== undefined)
    return {
      ...spec,
      cwd: spec.cwd ?? defaultCwd,
      privateEndpoint: spec.privateEndpoint ?? defaultPrivateEndpoint,
    };
  return undefined;
};
