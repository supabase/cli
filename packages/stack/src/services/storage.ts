import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import { removePathOnOrphanCleanup } from "./docker-cleanup.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";
import type { StorageVectorRuntimeConfig } from "../StackConfig.ts";

interface DockerStorageOptions {
  readonly image: string;
  readonly port: number;
  readonly apiPort: number;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dataDir: string;
  readonly anonKey: string;
  readonly serviceKey: string;
  readonly jwtSecret: string;
  readonly jwtJwks: string;
  readonly fileSizeLimit: string;
  readonly enableImageTransformation: boolean;
  readonly imgproxyUrl: string;
  readonly s3ProtocolEnabled: boolean;
  readonly vectorRuntime?: StorageVectorRuntimeConfig;
  readonly platformOs: string;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly cleanupDataDirOnExit?: boolean;
}

const STORAGE_DATA_DIR = "/var/lib/storage";

export const LOCAL_S3_PROTOCOL_ACCESS_KEY_ID = "local";
export const LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET = "local-secret";

const orphanCleanup = (opts: DockerStorageOptions) =>
  opts.cleanupDataDirOnExit ? removePathOnOrphanCleanup(opts.dataDir, { recursive: true }) : [];

const storageHealthCheck = (port: number): ServiceDef["healthCheck"] => ({
  probe: {
    _tag: "Http",
    host: "127.0.0.1",
    port,
    path: "/status",
    scheme: "http",
  },
  ...stackHealthBudgets.storage,
});

export const makeStorageServiceDocker = (opts: DockerStorageOptions): ServiceDef => {
  const env: Record<string, string> = {
    PORT: String(opts.port),
    ANON_KEY: opts.anonKey,
    SERVICE_KEY: opts.serviceKey,
    AUTH_JWT_SECRET: opts.jwtSecret,
    PGRST_JWT_SECRET: opts.jwtSecret,
    JWT_JWKS: opts.jwtJwks,
    DATABASE_URL: `postgresql://supabase_storage_admin:postgres@${opts.dbHost}:${opts.dbPort}/postgres`,
    FILE_SIZE_LIMIT: opts.fileSizeLimit,
    STORAGE_BACKEND: "file",
    FILE_STORAGE_BACKEND_PATH: STORAGE_DATA_DIR,
    STORAGE_FILE_BACKEND_PATH: STORAGE_DATA_DIR,
    TENANT_ID: "stub",
    STORAGE_S3_REGION: "local",
    GLOBAL_S3_BUCKET: "stub",
    ENABLE_IMAGE_TRANSFORMATION: String(opts.enableImageTransformation),
    IMGPROXY_URL: opts.imgproxyUrl,
    TUS_URL_PATH: "/storage/v1/upload/resumable",
    S3_PROTOCOL_ENABLED: String(opts.s3ProtocolEnabled),
    S3_PROTOCOL_ACCESS_KEY_ID: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
    S3_PROTOCOL_ACCESS_KEY_SECRET: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
    S3_PROTOCOL_PREFIX: "/storage/v1",
    UPLOAD_FILE_SIZE_LIMIT: "52428800000",
    UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
    SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
  };
  if (opts.vectorRuntime !== undefined) {
    env.VECTOR_ENABLED = opts.vectorRuntime.enabled;
    env.VECTOR_BUCKET_PROVIDER = opts.vectorRuntime.provider;
    env.VECTOR_STORE_MIGRATIONS_ENABLED = opts.vectorRuntime.migrationsEnabled;
    env.VECTOR_DATABASE_URL =
      opts.vectorRuntime.databaseUrl ??
      `postgresql://postgres:postgres@${opts.dbHost}:${opts.dbPort}/postgres`;
  }

  return dockerRunService({
    name: "storage",
    apiPort: opts.apiPort,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:${STORAGE_DATA_DIR}`],
    env,
    dependencies: opts.dependencies,
    healthCheck: storageHealthCheck(opts.port),
    orphanCleanup: orphanCleanup(opts),
  });
};
