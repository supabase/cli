import type { ServiceDef } from "@supabase/process-compose";
import { removePathOnOrphanCleanup } from "./docker-cleanup.ts";
import { dockerRunService, type ServiceDependency } from "./service-utils.ts";

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
  readonly networkArgs: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<ServiceDependency>;
  readonly cleanupDataDirOnExit?: boolean;
}

const STORAGE_DATA_DIR = "/var/lib/storage";

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
  initialDelaySeconds: 1,
  periodSeconds: 0.5,
  failureThreshold: 30,
});

export const makeStorageServiceDocker = (opts: DockerStorageOptions): ServiceDef =>
  dockerRunService({
    name: "storage",
    containerName: `supabase-storage-${opts.apiPort}`,
    image: opts.image,
    networkArgs: opts.networkArgs,
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
      IMGPROXY_URL: opts.imgproxyUrl,
      TUS_URL_PATH: "/storage/v1/upload/resumable",
      S3_PROTOCOL_ENABLED: String(opts.s3ProtocolEnabled),
      S3_PROTOCOL_ACCESS_KEY_ID: "local",
      S3_PROTOCOL_ACCESS_KEY_SECRET: "local-secret",
      S3_PROTOCOL_PREFIX: "/storage/v1",
      UPLOAD_FILE_SIZE_LIMIT: "52428800000",
      UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
      SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
    },
    dependsOn: opts.dependencies,
    healthCheck: storageHealthCheck(opts.port),
    orphanCleanup: orphanCleanup(opts),
  });
