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
  s3ProtocolEnabled: Schema.optionalKey(Schema.Boolean),
  vectorEnabled: Schema.optionalKey(Schema.Boolean),
  vectorDatabaseUrl: Schema.optionalKey(Schema.String),
  vectorMaxBuckets: Schema.optionalKey(Schema.Finite),
  vectorMaxIndexes: Schema.optionalKey(Schema.Finite),
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
        ...(creation.config.s3ProtocolEnabled === undefined
          ? {}
          : { S3_PROTOCOL_ENABLED: String(creation.config.s3ProtocolEnabled) }),
        ...(creation.config.vectorEnabled === undefined
          ? {}
          : { VECTOR_ENABLED: String(creation.config.vectorEnabled) }),
        ...(creation.config.vectorEnabled !== true
          ? {}
          : {
              VECTOR_BUCKET_PROVIDER: "pgvector",
              VECTOR_STORE_MIGRATIONS_ENABLED: "true",
              VECTOR_DATABASE_URL: creation.config.vectorDatabaseUrl ?? creation.config.databaseUrl,
            }),
        ...(creation.config.vectorMaxBuckets === undefined
          ? {}
          : { VECTOR_MAX_BUCKETS: String(creation.config.vectorMaxBuckets) }),
        ...(creation.config.vectorMaxIndexes === undefined
          ? {}
          : { VECTOR_MAX_INDEXES: String(creation.config.vectorMaxIndexes) }),
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
