import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  backend: Schema.optionalKey(Schema.Literal("postgres")),
  apiKey: Schema.optionalKey(Schema.String),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("analytics", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "analytics",
  executable: "bin/logflare",
  ports: { http: 4000 },
  healthPath: "/health",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const db = yield* databaseConnection(creation.config.databaseUrl);
      return {
        DATABASE_URL: creation.config.databaseUrl,
        ...(http === undefined
          ? {}
          : { PORT: String(http.port), PHX_HTTP_PORT: String(http.port) }),
        DB_DATABASE: "_supabase",
        DB_SCHEMA: "_analytics",
        DB_HOSTNAME: db.host,
        DB_PORT: db.port,
        DB_USERNAME: db.username ?? "supabase_admin",
        DB_PASSWORD: db.password ?? "postgres",
        LOGFLARE_SUPABASE_MODE: "true",
        LOGFLARE_SINGLE_TENANT: "true",
        ...(container ? {} : { LOGFLARE_GRPC_PORT: "0" }),
        ...(creation.config.apiKey === undefined
          ? {}
          : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
        POSTGRES_BACKEND_URL: creation.config.databaseUrl,
        POSTGRES_BACKEND_SCHEMA: "_analytics",
      };
    }),
  args: () => Effect.succeed(["start"]),
  mounts: () => Effect.succeed([]),
  startup: [{ args: [], nativeExecutable: "prepare", skipInContainer: true }],
});
