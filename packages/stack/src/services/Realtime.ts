import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, localJwtSecret } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  jwtSecret: Schema.optionalKey(Schema.String),
  dbEncryptionKey: Schema.optionalKey(Schema.String),
  secretKeyBase: Schema.optionalKey(Schema.String),
  ipVersion: Schema.optionalKey(Schema.Literals(["IPv4", "IPv6"])),
  maxHeaderLength: Schema.optionalKey(Schema.Finite),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({
  http: Schema.optionalKey(EndpointIntent),
  rpc: Schema.optionalKey(EndpointIntent),
});

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("realtime", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "realtime",
  executable: "bin/server",
  ports: { http: 4000, rpc: 5369 },
  healthPath: "/healthcheck",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const db = yield* databaseConnection(creation.config.databaseUrl);
      const http = endpoints.get("http");
      const rpc = endpoints.get("rpc");
      const jwt = creation.config.jwtSecret ?? localJwtSecret;
      return {
        DATABASE_URL: creation.config.databaseUrl,
        ...(http === undefined ? {} : { PORT: String(http.port) }),
        DB_URL: creation.config.databaseUrl,
        DB_HOST: db.host,
        DB_PORT: db.port,
        DB_USER: db.username ?? "supabase_admin",
        DB_PASSWORD: db.password ?? "postgres",
        DB_NAME: db.database,
        DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
        API_JWT_SECRET: jwt,
        METRICS_JWT_SECRET: jwt,
        DB_ENC_KEY: creation.config.dbEncryptionKey ?? "0123456789abcdef",
        SECRET_KEY_BASE: creation.config.secretKeyBase ?? localJwtSecret,
        DNS_NODES: "''",
        APP_NAME: "realtime",
        SEED_SELF_HOST: "true",
        MAX_HEADER_LENGTH: String(creation.config.maxHeaderLength ?? 4096),
        ERL_AFLAGS:
          creation.config.ipVersion === "IPv6" ? "-proto_dist inet6_tcp" : "-proto_dist inet_tcp",
        RUN_JANITOR: "true",
        ...(rpc === undefined
          ? {}
          : {
              GEN_RPC_TCP_SERVER_PORT: String(rpc.port),
              GEN_RPC_TCP_CLIENT_PORT: String(rpc.port),
              GEN_RPC_SOCKET_IP: container ? "0.0.0.0" : "127.0.0.1",
            }),
      };
    }),
  args: (_creation, _endpoints, context) =>
    Effect.succeed(context.container ? ["-s", "-g", "--", "/app/bin/server"] : []),
  mounts: () => Effect.succeed([]),
  startup: [{ args: [], containerEntrypoint: "/app/bin/prepare" }],
  containerEntrypoint: () => "/usr/bin/tini",
});
