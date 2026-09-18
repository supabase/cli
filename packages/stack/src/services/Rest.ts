import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  externalApiUrl: Schema.optionalKey(Schema.String),
  schemas: Schema.optionalKey(Schema.String),
  anonRole: Schema.optionalKey(Schema.String),
  jwtSecret: Schema.optionalKey(Schema.String),
  jwks: Schema.optionalKey(Schema.String),
  maxRows: Schema.optionalKey(Schema.Finite),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("rest", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "rest",
  executable: "bin/postgrest",
  ports: { http: 3000 },
  healthPath: "/",
  env: (creation, endpoints) => {
    const http = endpoints.get("http");
    const jwtSecret = creation.config.jwtSecret ?? creation.config.jwks;
    return Effect.succeed({
      DATABASE_URL: creation.config.databaseUrl,
      PGRST_DB_URI: creation.config.databaseUrl,
      ...(http === undefined ? {} : { PGRST_SERVER_PORT: String(http.port) }),
      PGRST_DB_SCHEMAS: creation.config.schemas ?? "public,graphql_public",
      PGRST_DB_ANON_ROLE: creation.config.anonRole ?? "anon",
      PGRST_DB_MAX_ROWS: String(creation.config.maxRows ?? 1000),
      ...(jwtSecret === undefined ? {} : { PGRST_JWT_SECRET: jwtSecret }),
      ...(creation.config.externalApiUrl === undefined
        ? {}
        : { PGRST_OPENAPI_SERVER_PROXY_URI: creation.config.externalApiUrl }),
    });
  },
  args: () => Effect.succeed([]),
  mounts: () => Effect.succeed([]),
  startup: [],
});
