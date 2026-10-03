import { Effect, Schema } from "effect";
import {
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
} from "../Defaults.ts";
import { EndpointIntent, serviceCreation } from "./Recipe.ts";
import { databaseConnection, requiredInput, localJwtSecret, serviceJwt } from "./ServiceConfig.ts";
import { type ProcessRecipeSpec, type StartupCommand } from "./ProcessRecipe.ts";

export const Config = Schema.Struct({
  databaseUrl: Schema.optionalKey(Schema.String),
  filePath: Schema.String,
  jwtSecret: Schema.optionalKey(Schema.String),
  jwks: Schema.optionalKey(Schema.String),
  anonKey: Schema.optionalKey(Schema.String),
  serviceRoleKey: Schema.optionalKey(Schema.String),
  imgproxyUrl: Schema.optionalKey(Schema.String),
  fileSizeLimit: Schema.optionalKey(Schema.String),
  s3ProtocolEnabled: Schema.optionalKey(Schema.Boolean),
  s3AccessKeyId: Schema.optionalKey(Schema.String),
  s3SecretAccessKey: Schema.optionalKey(Schema.String),
  s3Region: Schema.optionalKey(Schema.String),
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

/** Path prefix the stack gateway strips before forwarding a request to Storage. */
export const apiPath = "/storage/v1";

export const initializationCommand = {
  args: [],
  containerEntrypoint: "/slim-runtime/bin/prepare",
} satisfies StartupCommand & { readonly containerEntrypoint: string };

export const makeSpec = (): ProcessRecipeSpec<Creation> => ({
  service: "storage",
  executable: "bin/storage",
  ports: { http: 5000 },
  healthPath: "/status",
  env: (creation, endpoints, container) =>
    Effect.gen(function* () {
      const http = endpoints.get("http");
      const databaseUrl = yield* requiredInput(
        "storage",
        "databaseUrl",
        creation.config.databaseUrl,
      );
      const db = yield* databaseConnection(databaseUrl);
      const jwt = creation.config.jwtSecret ?? localJwtSecret;
      const anon = yield* serviceJwt("anon", jwt);
      const service = yield* serviceJwt("service_role", jwt);
      const filePath = container ? "/mnt" : creation.config.filePath;
      return {
        DATABASE_URL: databaseUrl,
        ...(http === undefined ? {} : { STORAGE_PORT: String(http.port), PORT: String(http.port) }),
        ANON_KEY: creation.config.anonKey ?? anon,
        SERVICE_KEY: creation.config.serviceRoleKey ?? service,
        AUTH_JWT_SECRET: jwt,
        PGRST_JWT_SECRET: jwt,
        ...(creation.config.jwks === undefined ? {} : { JWT_JWKS: creation.config.jwks }),
        // The Storage image sets NODE_ENV=production, which forces https into TUS upload URLs.
        NODE_ENV: "development",
        TENANT_ID: "stub",
        REGION: "local",
        STORAGE_S3_REGION: creation.config.s3Region ?? DEFAULT_LOCAL_S3_REGION,
        GLOBAL_S3_BUCKET: "stub",
        STORAGE_BACKEND: "file",
        DB_HOST: db.host,
        DB_PORT: db.port,
        DB_USER: db.username ?? "supabase_admin",
        DB_PASSWORD: db.password ?? "postgres",
        DB_NAME: db.database,
        FILE_STORAGE_BACKEND_PATH: filePath,
        STORAGE_FILE_BACKEND_PATH: filePath,
        TUS_URL_PATH: `${apiPath}/upload/resumable`,
        S3_PROTOCOL_PREFIX: apiPath,
        S3_PROTOCOL_ACCESS_KEY_ID: creation.config.s3AccessKeyId ?? DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
        S3_PROTOCOL_ACCESS_KEY_SECRET:
          creation.config.s3SecretAccessKey ?? DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
        UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
        SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
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
              VECTOR_DATABASE_URL: creation.config.vectorDatabaseUrl ?? databaseUrl,
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
              IMAGE_TRANSFORMATION_ENABLED: "true",
            }),
      };
    }),
  args: () => Effect.succeed([]),
  mounts: (creation, _context) =>
    Effect.succeed([{ source: creation.config.filePath, target: "/mnt", readOnly: false }]),
  startupCommands: [initializationCommand],
  callerPaths: (creation) => [creation.config.filePath],
});
