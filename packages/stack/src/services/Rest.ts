import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";
import { requiredInput } from "./ServiceConfig.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.optionalKey(Schema.String),
  externalApiUrl: Schema.optionalKey(Schema.String),
  schemas: Schema.optionalKey(Schema.String),
  extraSearchPath: Schema.optionalKey(Schema.String),
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
  env: (creation, endpoints) =>
    Effect.gen(function* () {
      const databaseUrl = yield* requiredInput("rest", "databaseUrl", creation.config.databaseUrl);
      const http = endpoints.get("http");
      const jwtSecret = creation.config.jwks ?? creation.config.jwtSecret;
      return {
        DATABASE_URL: databaseUrl,
        PGRST_DB_URI: databaseUrl,
        ...(http === undefined ? {} : { PGRST_SERVER_PORT: String(http.port) }),
        PGRST_DB_SCHEMAS: creation.config.schemas ?? "public,graphql_public",
        ...(creation.config.extraSearchPath === undefined
          ? {}
          : { PGRST_DB_EXTRA_SEARCH_PATH: creation.config.extraSearchPath }),
        PGRST_DB_ANON_ROLE: creation.config.anonRole ?? "anon",
        PGRST_DB_MAX_ROWS: String(creation.config.maxRows ?? 1000),
        ...(jwtSecret === undefined ? {} : { PGRST_JWT_SECRET: jwtSecret }),
        ...(creation.config.externalApiUrl === undefined
          ? {}
          : { PGRST_OPENAPI_SERVER_PROXY_URI: creation.config.externalApiUrl }),
      };
    }),
  args: () => Effect.succeed([]),
  mounts: () => Effect.succeed([]),
  startup: [],
});
