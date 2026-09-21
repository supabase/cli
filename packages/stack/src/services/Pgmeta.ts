import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({ databaseUrl: Schema.String });

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("pgmeta", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "pgmeta",
  executable: "bin/pgmeta",
  ports: { http: 8080 },
  healthPath: "/health",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const db = yield* databaseConnection(creation.config.databaseUrl);
      return {
        DATABASE_URL: creation.config.databaseUrl,
        PG_META_HOST: container ? "0.0.0.0" : "127.0.0.1",
        ...(container ? {} : { PG_META_ADMIN_PORT: "0" }),
        ...(http === undefined ? {} : { PG_META_PORT: String(http.port) }),
        PG_META_DB_URL: creation.config.databaseUrl,
        PG_META_DB_HOST: db.host,
        PG_META_DB_PORT: db.port,
        PG_META_DB_NAME: db.database,
        PG_META_DB_USER: db.username ?? "supabase_admin",
        PG_META_DB_PASSWORD: db.password ?? "postgres",
      };
    }),
  args: () => Effect.succeed([]),
  mounts: () => Effect.succeed([]),
  startup: [],
});
