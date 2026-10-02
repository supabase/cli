import { Effect, Schema } from "effect";
import { ServiceError } from "../Service.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, requiredInput } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.optionalKey(Schema.String),
  backend: Schema.optionalKey(Schema.Literal("postgres")),
  apiKey: Schema.optionalKey(Schema.String),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("analytics", Config, Endpoints);

/** The schema holding Analytics' sources and the event tables of its Postgres backend. */
export const schema = "_analytics";

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

/** The database Logflare keeps its sources and its Postgres backend's event tables in. */
interface BackendConnection {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly username: string;
  readonly password: string;
  /** The connection as a URL, with the query parameters of Analytics' database URL. */
  readonly url: string;
}

/** Derives Logflare's backend database from Analytics' database URL and its credential defaults. */
export const backendConnection = Effect.fn("Analytics.backendConnection")(function* (
  databaseUrl: string,
) {
  const db = yield* databaseConnection(databaseUrl);
  const connection = {
    host: db.host,
    port: db.port,
    database: "_supabase",
    username: db.username ?? "supabase_admin",
    password: db.password ?? "postgres",
  };
  const url = yield* Effect.try({
    try: () => {
      const parsed = new URL(databaseUrl);
      parsed.username = encodeURIComponent(connection.username);
      parsed.password = encodeURIComponent(connection.password);
      parsed.pathname = `/${connection.database}`;
      return parsed.toString();
    },
    catch: (cause) =>
      new ServiceError({ operation: "launch", message: "Invalid Analytics database URL", cause }),
  });
  return { ...connection, url } satisfies BackendConnection;
});

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "analytics",
  executable: "bin/logflare",
  ports: { http: 4000 },
  healthPath: "/health",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const databaseUrl = yield* requiredInput(
        "analytics",
        "databaseUrl",
        creation.config.databaseUrl,
      );
      const backend = yield* backendConnection(databaseUrl);
      return {
        DATABASE_URL: databaseUrl,
        ...(http === undefined
          ? {}
          : { PORT: String(http.port), PHX_HTTP_PORT: String(http.port) }),
        DB_DATABASE: backend.database,
        DB_SCHEMA: schema,
        DB_HOSTNAME: backend.host,
        DB_PORT: backend.port,
        DB_USERNAME: backend.username,
        DB_PASSWORD: backend.password,
        LOGFLARE_SUPABASE_MODE: "true",
        LOGFLARE_SINGLE_TENANT: "true",
        ...(container ? {} : { LOGFLARE_GRPC_PORT: "0" }),
        ...(creation.config.apiKey === undefined
          ? {}
          : { LOGFLARE_PRIVATE_ACCESS_TOKEN: creation.config.apiKey }),
        POSTGRES_BACKEND_URL: backend.url,
        POSTGRES_BACKEND_SCHEMA: schema,
      };
    }),
  args: () => Effect.succeed(["start"]),
  mounts: () => Effect.succeed([]),
  startupCommands: [{ args: [], nativeExecutable: "prepare", skipInContainer: true }],
});
