import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, localJwtSecret } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  jwtSecret: Schema.optionalKey(Schema.String),
  tenant: Schema.optionalKey(Schema.String),
  defaultPoolSize: Schema.optionalKey(Schema.Finite),
  maxClientConnections: Schema.optionalKey(Schema.Finite),
  poolMode: Schema.optionalKey(Schema.Literals(["transaction", "session"])),
});
export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({
  http: Schema.optionalKey(EndpointIntent),
  sql: Schema.optionalKey(EndpointIntent),
});
export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("pooler", Config, Endpoints);
export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "pooler",
  executable: "bin/server",
  ports: { http: 4000, sql: 6543 },
  healthPath: "/api/health",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const sql = endpoints.get("sql");
      const db = yield* databaseConnection(creation.config.databaseUrl);
      const mode = creation.config.poolMode ?? "transaction";
      return {
        DATABASE_URL: creation.config.databaseUrl,
        ...(http === undefined ? {} : { PORT: String(http.port) }),
        ...(creation.config.tenant === undefined ? {} : { TENANT_ID: creation.config.tenant }),
        POSTGRES_HOST: db.host,
        POSTGRES_PORT: db.port,
        POSTGRES_USER: db.username ?? "supabase_admin",
        POSTGRES_PASSWORD: db.password ?? "postgres",
        API_JWT_SECRET: creation.config.jwtSecret ?? localJwtSecret,
        METRICS_JWT_SECRET: creation.config.jwtSecret ?? localJwtSecret,
        REGION: "local",
        CLUSTER_POSTGRES: "true",
        SECRET_KEY_BASE: localJwtSecret,
        VAULT_ENC_KEY: "0123456789abcdef0123456789abcdef",
        DEFAULT_POOL_SIZE: String(creation.config.defaultPoolSize ?? 20),
        MAX_CLIENT_CONN: String(creation.config.maxClientConnections ?? 100),
        POOL_MODE: mode,
        // Supavisor advertises Ranch-bound ports, so native instances can use ephemeral internal listeners.
        ...(container
          ? {}
          : {
              PROXY_PORT: "0",
              SESSION_PROXY_PORTS: "0",
              TRANSACTION_PROXY_PORTS: "0",
            }),
        ...(sql === undefined
          ? {}
          : {
              PROXY_PORT_SESSION: String(container ? 5432 : mode === "session" ? sql.port : 0),
              PROXY_PORT_TRANSACTION: String(
                container ? 6543 : mode === "transaction" ? sql.port : 0,
              ),
            }),
      };
    }),
  args: (_creation, _endpoints, context) =>
    Effect.succeed(context.container ? ["-s", "-g", "--", "/app/bin/server"] : ["start"]),
  mounts: () => Effect.succeed([]),
  containerPort: (creation, name, port) =>
    name === "sql" && creation.config.poolMode === "session" ? 5432 : port,
  containerEntrypoint: () => "/usr/bin/tini",
  startup: [
    { args: [], nativeExecutable: "prepare", containerEntrypoint: "/app/bin/prepare" },
    {
      args: [],
      nativeExecutable: "provision-tenant",
      containerEntrypoint: "/app/bin/provision-tenant",
    },
  ],
});
