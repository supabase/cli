import { Effect, Schema } from "effect";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, localJwtSecret, serviceJwt } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.String,
  filePath: Schema.String,
  jwtSecret: Schema.optionalKey(Schema.String),
  imgproxyUrl: Schema.optionalKey(Schema.String),
  fileSizeLimit: Schema.optionalKey(Schema.String),
});

export interface Config extends Schema.Schema.Type<typeof Config> {}
export const Endpoints = Schema.Struct({ http: Schema.optionalKey(EndpointIntent) });

export interface Endpoints extends Schema.Schema.Type<typeof Endpoints> {}
export const Creation = serviceCreation("storage", Config, Endpoints);

export interface Creation extends Schema.Schema.Type<typeof Creation> {}

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "storage",
  executable: "bin/storage",
  ports: { http: 5000 },
  healthPath: "/status",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const db = yield* databaseConnection(creation.config.databaseUrl);
      const jwt = creation.config.jwtSecret ?? localJwtSecret;
      const anon = yield* serviceJwt("anon", jwt);
      const service = yield* serviceJwt("service_role", jwt);
      const filePath = container ? "/mnt" : creation.config.filePath;
      return {
        DATABASE_URL: creation.config.databaseUrl,
        ...(http === undefined ? {} : { STORAGE_PORT: String(http.port), PORT: String(http.port) }),
        ANON_KEY: anon,
        SERVICE_KEY: service,
        AUTH_JWT_SECRET: jwt,
        PGRST_JWT_SECRET: jwt,
        TENANT_ID: "stub",
        REGION: "local",
        GLOBAL_S3_BUCKET: "stub",
        STORAGE_BACKEND: "file",
        DB_HOST: db.host,
        DB_PORT: db.port,
        DB_USER: db.username ?? "supabase_admin",
        DB_PASSWORD: db.password ?? "postgres",
        DB_NAME: db.database,
        FILE_STORAGE_BACKEND_PATH: filePath,
        STORAGE_FILE_BACKEND_PATH: filePath,
        ...(creation.config.fileSizeLimit === undefined
          ? {}
          : { FILE_SIZE_LIMIT: creation.config.fileSizeLimit }),
        ...(creation.config.imgproxyUrl === undefined
          ? {}
          : {
              IMGPROXY_URL: creation.config.imgproxyUrl,
              ENABLE_IMAGE_TRANSFORMATION: "true",
            }),
      };
    }),
  args: () => Effect.succeed([]),
  mounts: (creation, _context) =>
    Effect.succeed([{ source: creation.config.filePath, target: "/mnt", readOnly: false }]),
  startup: [{ args: [], containerEntrypoint: "/slim-runtime/bin/prepare" }],
});
