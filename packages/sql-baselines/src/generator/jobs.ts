import type { ServiceName } from "../Manifest.ts";
import { LOCAL_DEV, localDevJwks, signLocalDevJwt } from "./localdev.ts";

/**
 * A one-shot migrate job, mirroring the CLI's `initRealtimeJob` /
 * `initStorageJob` / `initAuthJob` (`apps/cli-go/internal/db/start/start.go`)
 * verbatim. The generator runs these exactly as `db start` does; the bundle
 * is whatever database state they leave behind.
 */
export interface MigrateJob {
  readonly service: ServiceName;
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cmd: ReadonlyArray<string>;
  /** Role the job connects as — recorded in the manifest for provenance. */
  readonly serviceRole: string;
  /**
   * Qualified tables captured byte-exactly in the bundle's data file. These
   * are what the service validates at boot (versions, sha1 hashes), so
   * byte-exact rows are what make a booted service no-op.
   */
  readonly trackingTables: ReadonlyArray<string>;
  /**
   * Regexes (matched against `schema.qualified_name`) for objects the
   * generation run creates that cannot be static and are dropped before the
   * post-job snapshot. The service recreates them at runtime.
   */
  readonly excluded: ReadonlyArray<string>;
}

export interface JobInputs {
  /** In-network hostname of the postgres container. */
  readonly dbHost: string;
  readonly images: Readonly<Record<ServiceName, string>>;
}

const realtimeJob = ({ dbHost, images }: JobInputs): MigrateJob => ({
  service: "realtime",
  image: images.realtime,
  env: {
    PORT: "4000",
    DB_HOST: dbHost,
    DB_PORT: "5432",
    DB_USER: "supabase_admin",
    DB_PASSWORD: LOCAL_DEV.dbPassword,
    DB_NAME: "postgres",
    DB_AFTER_CONNECT_QUERY: "SET search_path TO _realtime",
    DB_ENC_KEY: LOCAL_DEV.realtime.encryptionKey,
    API_JWT_JWKS: localDevJwks(LOCAL_DEV.jwtSecret),
    API_JWT_SECRET: LOCAL_DEV.jwtSecret,
    METRICS_JWT_SECRET: LOCAL_DEV.jwtSecret,
    APP_NAME: "realtime",
    SECRET_KEY_BASE: LOCAL_DEV.realtime.secretKeyBase,
    ERL_AFLAGS: LOCAL_DEV.realtime.erlAflags,
    DNS_NODES: "''",
    RLIMIT_NOFILE: "",
    SEED_SELF_HOST: "true",
    RUN_JANITOR: "true",
    MAX_HEADER_LENGTH: String(LOCAL_DEV.realtime.maxHeaderLength),
  },
  cmd: [
    "/app/bin/realtime",
    "eval",
    `{:ok, _} = Application.ensure_all_started(:realtime)
{:ok, _} = Realtime.Tenants.health_check("${LOCAL_DEV.realtime.tenantId}")`,
  ],
  serviceRole: "supabase_admin",
  trackingTables: [
    "realtime.schema_migrations",
    "_realtime.schema_migrations",
    "_realtime.tenants",
    "_realtime.extensions",
  ],
  // Daily partitions created by the tenant health check; stale on replay and
  // recreated by the service on every connect.
  excluded: [String.raw`^realtime\.messages_\d{4}_\d{2}_\d{2}$`],
});

const storageJob = ({ dbHost, images }: JobInputs): MigrateJob => ({
  service: "storage",
  image: images.storage,
  env: {
    DB_INSTALL_ROLES: "false",
    // DB_MIGRATIONS_FREEZE_AT deliberately unset: a bundle reproduces the
    // full state of the pinned storage release, not a frozen subset.
    ANON_KEY: signLocalDevJwt("anon", LOCAL_DEV.jwtSecret),
    SERVICE_KEY: signLocalDevJwt("service_role", LOCAL_DEV.jwtSecret),
    PGRST_JWT_SECRET: LOCAL_DEV.jwtSecret,
    DATABASE_URL: `postgresql://supabase_storage_admin:${LOCAL_DEV.dbPassword}@${dbHost}:5432/postgres`,
    FILE_SIZE_LIMIT: String(LOCAL_DEV.storage.fileSizeLimitBytes),
    STORAGE_BACKEND: "file",
    STORAGE_FILE_BACKEND_PATH: "/mnt",
    TENANT_ID: "stub",
    REGION: "stub",
    GLOBAL_S3_BUCKET: "stub",
  },
  cmd: ["node", "dist/scripts/migrate-call.js"],
  serviceRole: "supabase_storage_admin",
  trackingTables: ["storage.migrations"],
  excluded: [],
});

const authJob = ({ dbHost, images }: JobInputs): MigrateJob => ({
  service: "auth",
  image: images.auth,
  env: {
    API_EXTERNAL_URL: LOCAL_DEV.authExternalUrl,
    GOTRUE_LOG_LEVEL: "error",
    GOTRUE_DB_DRIVER: "postgres",
    GOTRUE_DB_DATABASE_URL: `postgresql://supabase_auth_admin:${LOCAL_DEV.dbPassword}@${dbHost}:5432/postgres`,
    GOTRUE_SITE_URL: LOCAL_DEV.siteUrl,
    GOTRUE_JWT_SECRET: LOCAL_DEV.jwtSecret,
  },
  cmd: ["gotrue", "migrate"],
  serviceRole: "supabase_auth_admin",
  trackingTables: ["auth.schema_migrations"],
  excluded: [],
});

/** Migrate jobs in the canonical order the CLI runs them. */
export const migrateJobs = (inputs: JobInputs): ReadonlyArray<MigrateJob> => [
  realtimeJob(inputs),
  storageJob(inputs),
  authJob(inputs),
];
