import type { ServiceDef } from "@supabase/process-compose";
import { dockerNetworkArgs } from "../Platform.ts";
import type { StackIdentity } from "../StackIdentity.ts";
import { removePathOnOrphanCleanup } from "./docker-cleanup.ts";
import {
  dockerRunService,
  nativeRunService,
  type ContainerRuntimeOptions,
  type ServiceDependency,
} from "./service-utils.ts";
import { stackHealthBudgets } from "./health-budgets.ts";

interface StorageServiceOptions {
  readonly port: number;
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
  readonly dependencies: ReadonlyArray<ServiceDependency>;
}

export interface NativeStorageOptions extends StorageServiceOptions {
  readonly binPath: string;
  readonly cleanupDataDirOnExit?: boolean;
}

interface DockerStorageOptions extends StorageServiceOptions, ContainerRuntimeOptions {
  readonly image: string;
  readonly identity: StackIdentity;
  readonly dbHost: string;
  readonly platformOs: string;
  readonly cleanupDataDirOnExit?: boolean;
}

const STORAGE_DATA_DIR = "/var/lib/storage";

export const LOCAL_S3_PROTOCOL_ACCESS_KEY_ID = "local";
export const LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET = "local-secret";

const orphanCleanup = (
  opts: Pick<StorageServiceOptions, "dataDir"> & { cleanupDataDirOnExit?: boolean },
) =>
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

const storageNativeEnv = (opts: NativeStorageOptions): Record<string, string> => ({
  SERVER_HOST: "127.0.0.1",
  SERVER_PORT: String(opts.port),
  ANON_KEY: opts.anonKey,
  SERVICE_KEY: opts.serviceKey,
  AUTH_JWT_SECRET: opts.jwtSecret,
  PGRST_JWT_SECRET: opts.jwtSecret,
  JWT_JWKS: opts.jwtJwks,
  DATABASE_URL: `postgresql://supabase_storage_admin:postgres@127.0.0.1:${opts.dbPort}/postgres`,
  FILE_SIZE_LIMIT: opts.fileSizeLimit,
  STORAGE_BACKEND: "file",
  FILE_STORAGE_BACKEND_PATH: opts.dataDir,
  STORAGE_FILE_BACKEND_PATH: opts.dataDir,
  TENANT_ID: "stub",
  STORAGE_S3_REGION: "local",
  GLOBAL_S3_BUCKET: "stub",
  ENABLE_IMAGE_TRANSFORMATION: String(opts.enableImageTransformation),
  IMAGE_TRANSFORMATION_ENABLED: String(opts.enableImageTransformation),
  IMGPROXY_URL: opts.imgproxyUrl,
  TUS_URL_PATH: "/storage/v1/upload/resumable",
  S3_PROTOCOL_ENABLED: String(opts.s3ProtocolEnabled),
  S3_PROTOCOL_ACCESS_KEY_ID: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
  S3_PROTOCOL_ACCESS_KEY_SECRET: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
  S3_PROTOCOL_PREFIX: "/storage/v1",
  UPLOAD_FILE_SIZE_LIMIT: "52428800000",
  UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
  SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
});

export const makeStorageServiceNative = (opts: NativeStorageOptions): ServiceDef => ({
  ...nativeRunService({
    name: "storage",
    command: `${opts.binPath}/bin/storage`,
    env: storageNativeEnv(opts),
    dependencies: opts.dependencies,
    healthCheck: storageHealthCheck(opts.port),
  }),
  supervision: { orphanCleanup: orphanCleanup(opts) },
});

export const makeStorageServiceDocker = (opts: DockerStorageOptions): ServiceDef =>
  dockerRunService({
    runtime: opts.runtime,
    name: "storage",
    identity: opts.identity,
    image: opts.image,
    networkArgs: dockerNetworkArgs(opts.platformOs, [opts.port]),
    volumes: [`${opts.dataDir}:${STORAGE_DATA_DIR}`],
    env: {
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
      // storage-api prefers this key over ENABLE_IMAGE_TRANSFORMATION (v1.72+).
      IMAGE_TRANSFORMATION_ENABLED: String(opts.enableImageTransformation),
      IMGPROXY_URL: opts.imgproxyUrl,
      TUS_URL_PATH: "/storage/v1/upload/resumable",
      S3_PROTOCOL_ENABLED: String(opts.s3ProtocolEnabled),
      S3_PROTOCOL_ACCESS_KEY_ID: LOCAL_S3_PROTOCOL_ACCESS_KEY_ID,
      S3_PROTOCOL_ACCESS_KEY_SECRET: LOCAL_S3_PROTOCOL_ACCESS_KEY_SECRET,
      S3_PROTOCOL_PREFIX: "/storage/v1",
      UPLOAD_FILE_SIZE_LIMIT: "52428800000",
      UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
      SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
    },
    dependencies: opts.dependencies,
    healthCheck: storageHealthCheck(opts.port),
    orphanCleanup: orphanCleanup(opts),
  });
