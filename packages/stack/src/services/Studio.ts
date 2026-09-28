import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { serviceJwt } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  functionsRoot: Schema.optionalKey(Schema.String),
  pgmetaUrl: Schema.optionalKey(Schema.String),
  analyticsUrl: Schema.optionalKey(Schema.String),
  analyticsApiKey: Schema.optionalKey(Schema.String),
  functionsUrl: Schema.optionalKey(Schema.String),
  apiUrl: Schema.optionalKey(Schema.String),
  publicApiUrl: Schema.optionalKey(Schema.String),
  jwtSecret: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  publishableKey: Schema.optionalKey(Schema.String),
  secretKey: Schema.optionalKey(Schema.String),
  openaiApiKey: Schema.optionalKey(Schema.String),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("studio", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "studio",
  executable: "bin/studio",
  ports: { http: 3000 },
  healthPath: "/api/platform/profile",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const jwt = creation.config.jwtSecret;
      const anonKey =
        creation.config.anonKey ?? (jwt === undefined ? undefined : yield* serviceJwt("anon", jwt));
      const serviceRoleKey =
        creation.config.serviceRoleKey ??
        (jwt === undefined ? undefined : yield* serviceJwt("service_role", jwt));
      const values: Record<string, string> = {
        ...(http === undefined ? {} : { PORT: String(http.port) }),
        HOSTNAME: container ? "0.0.0.0" : "127.0.0.1",
      };
      if (creation.config.pgmetaUrl !== undefined)
        values.STUDIO_PG_META_URL = creation.config.pgmetaUrl;
      if (creation.config.analyticsUrl !== undefined)
        values.LOGFLARE_URL = creation.config.analyticsUrl;
      if (creation.config.analyticsApiKey !== undefined) {
        values.LOGFLARE_PRIVATE_ACCESS_TOKEN = creation.config.analyticsApiKey;
        values.NEXT_PUBLIC_ENABLE_LOGS = "true";
      }
      if (anonKey !== undefined) values.SUPABASE_ANON_KEY = anonKey;
      if (serviceRoleKey !== undefined) values.SUPABASE_SERVICE_KEY = serviceRoleKey;
      if (creation.config.publishableKey !== undefined)
        values.SUPABASE_PUBLISHABLE_KEY = creation.config.publishableKey;
      if (creation.config.secretKey !== undefined)
        values.SUPABASE_SECRET_KEY = creation.config.secretKey;
      if (creation.config.apiUrl !== undefined) values.SUPABASE_URL = creation.config.apiUrl;
      if (creation.config.publicApiUrl !== undefined)
        values.SUPABASE_PUBLIC_URL = creation.config.publicApiUrl;
      if (creation.config.openaiApiKey !== undefined)
        values.OPENAI_API_KEY = creation.config.openaiApiKey;
      if (creation.config.functionsRoot !== undefined)
        values.EDGE_FUNCTIONS_MANAGEMENT_FOLDER = container
          ? "/__supabase_functions"
          : creation.config.functionsRoot;
      if (creation.config.functionsUrl !== undefined)
        values.EDGE_FUNCTIONS_URL = creation.config.functionsUrl;
      return values;
    }),
  args: () => Effect.succeed([]),
  mounts: (creation) =>
    Effect.succeed(
      creation.config.functionsRoot === undefined
        ? []
        : [
            {
              source: creation.config.functionsRoot,
              target: "/__supabase_functions",
              readOnly: true,
            },
          ],
    ),
  startupCommands: [],
});
