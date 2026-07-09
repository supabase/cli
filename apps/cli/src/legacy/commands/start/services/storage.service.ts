/**
 * Port of Go's "Start Storage" block
 * (`apps/cli-go/internal/start/start.go:994-1057`), plus the vector-bucket
 * env helper `appendStorageVectorEnv` (`start.go:1487-1501`).
 *
 * Enabled gate: `isStorageEnabled` (`start.go:301`) —
 * `config.storage.enabled && !isContainerExcluded(storageImage, excluded)`.
 * Gating itself is the caller's responsibility (`start.services.ts`'s
 * `storage` catalog entry, `enabledGate: "storage.enabled"`); this module
 * only builds the container spec once called.
 *
 * `imageTransformationEnabled` (below) is Go's `isImgProxyEnabled` — a
 * COMPOUND value (`storage.enabled` is already implied by the fact Storage
 * itself is starting) `&& config.storage.image_transformation?.enabled &&
 * !isContainerExcluded(imgproxyImage, excluded)` (`start.go:302-303`), NOT
 * the bare `config.storage.image_transformation?.enabled` field alone. The
 * caller must compute this compound boolean exactly once and pass the SAME
 * value both here (`ENABLE_IMAGE_TRANSFORMATION`) and to the decision of
 * whether to actually start the ImgProxy container
 * (`imgproxy.service.ts`'s `legacyBuildImgproxyContainerSpec` precondition)
 * — the two must never disagree, matching Go's single shared
 * `isImgProxyEnabled` local variable (`start.go:995,1011,1060`).
 *
 * `s3ProtocolEnabled` is `config.storage.s3_protocol.enabled` directly (no
 * exclusion factor — S3 protocol support is a Storage feature flag, not a
 * separate container). Go models `S3Protocol` as a nilable pointer
 * (`*s3Protocol`, `pkg/config/storage.go:17`) that stays `nil` only when
 * `[storage.s3_protocol]` is entirely absent from BOTH the user's
 * `config.toml` and the embedded default template — but the embedded
 * template always sets `[storage.s3_protocol]\nenabled = true`
 * (`pkg/config/templates/config.toml:128-129`) and is merged in as the base
 * layer before any real config loads, so `S3Protocol` is non-nil for every
 * config `Config.Load` actually produces. `@supabase/config`'s schema
 * mirrors this by decoding `storage.s3_protocol` unconditionally (never
 * `optionalKey`, unlike `image_transformation`), so the raw decoded boolean
 * is already Go-equivalent with no extra presence check needed.
 */

import type { ProjectConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import { ramInBytes } from "../../../shared/legacy-size-units.ts";
import type { LegacyStartContainerSpec } from "../lib/docker-create-args.ts";
import {
  legacyStartInternalDbUrl,
  legacyStartInternalDbPassword,
} from "../lib/internal-db-connection.ts";

/** Go's `dockerStoragePath` local (`start.go:996`) — both the container's `FILE_STORAGE_BACKEND_PATH` and its named-volume mount target. */
const LEGACY_STORAGE_DOCKER_PATH = "/mnt";

/**
 * Go's `envOrDefault(key, def string) string` (`start.go:1466-1471`):
 * `os.LookupEnv`-if-set-else-default — an env var that is SET but empty is
 * used verbatim (unlike `legacy-local-config-values.ts`'s `envOverride`,
 * which treats an empty resolved value as unset). `projectEnvValues` mirrors
 * that module's own merged (dotenv + ambient shell, ambient-wins) map;
 * `??` only skips a `null`/`undefined` operand, never an empty string, so
 * this naturally reproduces `LookupEnv`'s "ok if set, even if empty"
 * semantics without a separate presence check. No `SUPABASE_` prefix and no
 * `env(VAR)` indirection — Go's raw `os.LookupEnv` here bypasses the
 * mapstructure decode-hook chain those only apply to.
 */
function legacyEnvOrDefault(
  key: string,
  def: string,
  projectEnvValues: Readonly<Record<string, string>> | undefined,
): string {
  return projectEnvValues?.[key] ?? process.env[key] ?? def;
}

export interface LegacyStorageVectorEnvInput {
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See `legacyStartInternalDbPassword` (`../lib/internal-db-connection.ts`). */
  readonly dbPassword: string;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Port of `appendStorageVectorEnv(env []string, dbConfig pgconn.Config)
 * []string` (`start.go:1473-1501`). Only called when
 * `config.storage.vector.enabled` (Go's `isVectorBucketsEnabled`,
 * `start.go:305,1022-1024`) — note the TOML key is `[storage.vector]`, not
 * `vector_buckets`; Go's Go-side struct field is named `VectorBuckets` but
 * tagged `toml:"vector"` (`pkg/config/storage.go:21`).
 */
export function legacyAppendStorageVectorEnv(
  env: Readonly<Record<string, string>>,
  input: LegacyStorageVectorEnvInput,
): Record<string, string> {
  const defaultVectorUrl = legacyStartInternalDbUrl("postgres", input.dbHost, input.dbPassword);
  return {
    ...env,
    VECTOR_ENABLED: legacyEnvOrDefault("VECTOR_ENABLED", "true", input.projectEnvValues),
    VECTOR_BUCKET_PROVIDER: legacyEnvOrDefault(
      "VECTOR_BUCKET_PROVIDER",
      "pgvector",
      input.projectEnvValues,
    ),
    VECTOR_STORE_MIGRATIONS_ENABLED: legacyEnvOrDefault(
      "VECTOR_STORE_MIGRATIONS_ENABLED",
      "true",
      input.projectEnvValues,
    ),
    VECTOR_DATABASE_URL: legacyEnvOrDefault(
      "VECTOR_DATABASE_URL",
      defaultVectorUrl,
      input.projectEnvValues,
    ),
  };
}

export interface LegacyStorageEnvInput {
  /**
   * Go's `utils.Config.Storage.TargetMigration` (`pkg/config/storage.go:13`) —
   * `toml:"-"`, resolved from a version-pin file
   * (`builder.StorageMigrationPath`, `config.go:844-846`), not from
   * `@supabase/config`'s schema. Out of scope for this builder (like `image`);
   * the caller resolves it and typically passes `""` when the file is absent,
   * matching Go's zero-value string default.
   */
  readonly targetMigration: string;
  /** `LegacyLocalConfigValues.anonKey`. */
  readonly anonKey: string;
  /** `LegacyLocalConfigValues.serviceRoleKey`. */
  readonly serviceRoleKey: string;
  /** `LegacyLocalConfigValues.jwtSecret`. */
  readonly jwtSecret: string;
  /** `legacyResolveLocalJwks`'s resolved JWKS JSON string. */
  readonly jwks: string;
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See `legacyStartInternalDbPassword` (`../lib/internal-db-connection.ts`). */
  readonly dbPassword: string;
  /** `config.storage.file_size_limit`, e.g. `"50MiB"` — converted to a byte count via `ramInBytes`. */
  readonly fileSizeLimit: ProjectConfig["storage"]["file_size_limit"];
  /** `LegacyLocalConfigValues.storageS3Region`. */
  readonly s3Region: string;
  /** `LegacyLocalConfigValues.storageS3AccessKeyId`. */
  readonly s3AccessKeyId: string;
  /** `LegacyLocalConfigValues.storageS3SecretAccessKey`. */
  readonly s3SecretAccessKey: string;
  /** Go's compound `isImgProxyEnabled` — see this file's header for why this is NOT the bare config field. */
  readonly imageTransformationEnabled: boolean;
  /** The ImgProxy container's own Docker name (`legacyServiceContainerName("imgproxy", projectId)`). */
  readonly imgproxyHost: string;
  /** `config.storage.s3_protocol.enabled` — see this file's header for why no extra presence check is needed. */
  readonly s3ProtocolEnabled: boolean;
  /** `config.storage.vector.enabled` (Go's `isVectorBucketsEnabled`). */
  readonly vectorBucketsEnabled: boolean;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Pure env-var builder, split out from {@link legacyBuildStorageContainerSpec}
 * so the full Go `storageEnv` literal (`start.go:997-1021`) — including the
 * conditional vector-bucket branch — is unit-testable without constructing a
 * whole container spec.
 */
export function legacyBuildStorageEnv(input: LegacyStorageEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    DB_MIGRATIONS_FREEZE_AT: input.targetMigration,
    ANON_KEY: input.anonKey,
    SERVICE_KEY: input.serviceRoleKey,
    AUTH_JWT_SECRET: input.jwtSecret,
    JWT_JWKS: input.jwks,
    DATABASE_URL: legacyStartInternalDbUrl(
      "supabase_storage_admin",
      input.dbHost,
      input.dbPassword,
    ),
    FILE_SIZE_LIMIT: String(ramInBytes(input.fileSizeLimit)),
    STORAGE_BACKEND: "file",
    FILE_STORAGE_BACKEND_PATH: LEGACY_STORAGE_DOCKER_PATH,
    TENANT_ID: "stub",
    // TODO (matches Go's own TODO, `start.go:1008`): https://github.com/supabase/storage-api/issues/55
    STORAGE_S3_REGION: input.s3Region,
    GLOBAL_S3_BUCKET: "stub",
    ENABLE_IMAGE_TRANSFORMATION: String(input.imageTransformationEnabled),
    IMGPROXY_URL: `http://${input.imgproxyHost}:5001`,
    TUS_URL_PATH: "/storage/v1/upload/resumable",
    S3_PROTOCOL_ENABLED: String(input.s3ProtocolEnabled),
    S3_PROTOCOL_ACCESS_KEY_ID: input.s3AccessKeyId,
    S3_PROTOCOL_ACCESS_KEY_SECRET: input.s3SecretAccessKey,
    S3_PROTOCOL_PREFIX: "/storage/v1",
    UPLOAD_FILE_SIZE_LIMIT: "52428800000",
    UPLOAD_FILE_SIZE_LIMIT_STANDARD: "5242880000",
    SIGNED_UPLOAD_URL_EXPIRATION_TIME: "7200",
  };

  return input.vectorBucketsEnabled
    ? legacyAppendStorageVectorEnv(env, {
        dbHost: input.dbHost,
        dbPassword: input.dbPassword,
        projectEnvValues: input.projectEnvValues,
      })
    : env;
}

export interface LegacyStorageContainerSpecInput {
  /** Go's `Config.ProjectId`, already sanitized — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Storage.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly targetMigration: string;
  readonly fileSizeLimit: ProjectConfig["storage"]["file_size_limit"];
  readonly s3Region: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly s3ProtocolEnabled: boolean;
  readonly imageTransformationEnabled: boolean;
  readonly vectorBucketsEnabled: boolean;
  /** `LegacyLocalConfigValues.dbUrl` — reused, not recomputed, to derive the internal DB password. */
  readonly dbUrl: string;
  readonly jwtSecret: string;
  readonly jwks: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Builds the `docker create` spec for the Storage container
 * (`start.go:994-1057`). `binds` mounts the container's own named volume at
 * `/mnt` (`container.HostConfig.Binds: []string{utils.StorageId + ":" +
 * dockerStoragePath}`, `start.go:1043`) — no `ports`/`exposedPorts`, Storage
 * is reached only via its Docker network alias.
 */
export function legacyBuildStorageContainerSpec(
  input: LegacyStorageContainerSpecInput,
): LegacyStartContainerSpec {
  const containerName = legacyServiceContainerName("storage", input.projectId);
  const env = legacyBuildStorageEnv({
    targetMigration: input.targetMigration,
    anonKey: input.anonKey,
    serviceRoleKey: input.serviceRoleKey,
    jwtSecret: input.jwtSecret,
    jwks: input.jwks,
    dbHost: legacyServiceContainerName("db", input.projectId),
    dbPassword: legacyStartInternalDbPassword(input.dbUrl),
    fileSizeLimit: input.fileSizeLimit,
    s3Region: input.s3Region,
    s3AccessKeyId: input.s3AccessKeyId,
    s3SecretAccessKey: input.s3SecretAccessKey,
    imageTransformationEnabled: input.imageTransformationEnabled,
    imgproxyHost: legacyServiceContainerName("imgproxy", input.projectId),
    s3ProtocolEnabled: input.s3ProtocolEnabled,
    vectorBucketsEnabled: input.vectorBucketsEnabled,
    projectEnvValues: input.projectEnvValues,
  });

  return {
    image: input.image,
    containerName,
    env,
    binds: [`${containerName}:${LEGACY_STORAGE_DOCKER_PATH}`],
    healthcheck: {
      // "For some reason, localhost resolves to IPv6 address on GitPod which breaks
      // healthcheck." (`start.go:1031`) — reproduced verbatim, IPv4 loopback pinned.
      test: [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:5000/status",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    // `utils.StorageAliases = []string{"storage"}` (`utils/config.go:42`).
    networkAliases: ["storage"],
    labels: {},
  };
}
