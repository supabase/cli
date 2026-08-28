/**
 * Storage container spec builder, plus the vector-bucket env helper
 * `legacyAppendStorageVectorEnv`.
 *
 * Enabled gate: `isStorageEnabled` — `config.storage.enabled &&
 * !isContainerExcluded(storageImage, excluded)`. Gating itself is the
 * caller's responsibility (`start.services.ts`'s `storage` catalog entry,
 * `enabledGate: "storage.enabled"`); this module only builds the container
 * spec once called.
 *
 * `imageTransformationEnabled` (below) is a COMPOUND value (`storage.enabled`
 * is already implied by the fact Storage itself is starting) &&
 * `config.storage.image_transformation?.enabled &&
 * !isContainerExcluded(imgproxyImage, excluded)`, NOT the bare
 * `config.storage.image_transformation?.enabled` field alone. The caller
 * must compute this compound boolean exactly once and pass the SAME value
 * both here (`ENABLE_IMAGE_TRANSFORMATION`) and to the decision of whether
 * to actually start the ImgProxy container
 * (`imgproxy.service.ts`'s `legacyBuildImgproxyContainerSpec` precondition)
 * — the two must never disagree.
 *
 * `s3ProtocolEnabled` is `config.storage.s3_protocol.enabled` directly (no
 * exclusion factor — S3 protocol support is a Storage feature flag, not a
 * separate container). The embedded default config template always sets
 * `[storage.s3_protocol]\nenabled = true` and is merged in as the base layer
 * before any real config loads, so this section is always present in
 * practice. `@supabase/config`'s schema mirrors this by decoding
 * `storage.s3_protocol` unconditionally (never `optionalKey`, unlike
 * `image_transformation`), so the raw decoded boolean needs no extra
 * PRESENCE check — but the caller is still responsible for applying
 * `SUPABASE_STORAGE_S3_PROTOCOL_ENABLED`/`SUPABASE_STORAGE_VECTOR_ENABLED`
 * (the same override mechanism `imageTransformationEnabled`'s own compound
 * gate already accounts for) before passing
 * `s3ProtocolEnabled`/`vectorBucketsEnabled` in.
 */

import type { CliConfig } from "@supabase/config";

import { legacyServiceContainerName } from "../../../shared/legacy-docker-ids.ts";
import type { LegacyStartContainerSpec } from "../../../shared/db-bootstrap/docker-create-args.ts";
import { ramInBytes } from "../../../shared/legacy-size-units.ts";
import { legacyEnvOrDefault } from "../lib/legacy-env-or-default.ts";
import {
  legacyStartInternalDbUrl,
  legacyStartInternalDbPassword,
} from "../../../shared/db-bootstrap/internal-db-connection.ts";

/** Both the container's `FILE_STORAGE_BACKEND_PATH` and its named-volume mount target. */
const LEGACY_STORAGE_DOCKER_PATH = "/mnt";

export interface LegacyStorageVectorEnvInput {
  /** The `db` container's own Docker name (`legacyServiceContainerName("db", projectId)`). */
  readonly dbHost: string;
  /** See `legacyStartInternalDbPassword` (`../../../shared/db-bootstrap/internal-db-connection.ts`). */
  readonly dbPassword: string;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Only called when `config.storage.vector.enabled` — note the TOML key is
 * `[storage.vector]`, not `vector_buckets`.
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
   * The storage target-migration pin, resolved from a version-pin file, not
   * from `@supabase/config`'s schema. Out of scope for this builder (like
   * `image`); the caller resolves it and typically passes `""` when the
   * file is absent.
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
  /** See `legacyStartInternalDbPassword` (`../../../shared/db-bootstrap/internal-db-connection.ts`). */
  readonly dbPassword: string;
  /** `config.storage.file_size_limit`, e.g. `"50MiB"` — converted to a byte count via `ramInBytes`. */
  readonly fileSizeLimit: CliConfig["storage"]["file_size_limit"];
  /** `LegacyLocalConfigValues.storageS3Region`. */
  readonly s3Region: string;
  /** `LegacyLocalConfigValues.storageS3AccessKeyId`. */
  readonly s3AccessKeyId: string;
  /** `LegacyLocalConfigValues.storageS3SecretAccessKey`. */
  readonly s3SecretAccessKey: string;
  /** The compound image-transformation-enabled boolean — see this file's header for why this is NOT the bare config field. */
  readonly imageTransformationEnabled: boolean;
  /** The ImgProxy container's own Docker name (`legacyServiceContainerName("imgproxy", projectId)`). */
  readonly imgproxyHost: string;
  /** `config.storage.s3_protocol.enabled` — see this file's header for why no extra presence check is needed. */
  readonly s3ProtocolEnabled: boolean;
  /** `config.storage.vector.enabled`. */
  readonly vectorBucketsEnabled: boolean;
  readonly projectEnvValues?: Readonly<Record<string, string>>;
}

/**
 * Pure env-var builder, split out from {@link legacyBuildStorageContainerSpec}
 * so the full env set — including the conditional vector-bucket branch — is
 * unit-testable without constructing a whole container spec.
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
    // TODO: https://github.com/supabase/storage-api/issues/55
    STORAGE_S3_REGION: input.s3Region,
    GLOBAL_S3_BUCKET: "stub",
    ENABLE_IMAGE_TRANSFORMATION: String(input.imageTransformationEnabled),
    // storage-api prefers this key over ENABLE_IMAGE_TRANSFORMATION, and the
    // slim storage image bakes IMAGE_TRANSFORMATION_ENABLED=false as an image
    // ENV default — set it explicitly so config.toml wins on both families.
    IMAGE_TRANSFORMATION_ENABLED: String(input.imageTransformationEnabled),
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
  /** The sanitized project id — see `legacyServiceContainerName`'s callers. */
  readonly projectId: string;
  /** `container.HostConfig.NetworkMode`/`network.NetworkingConfig` target — the `--network-id` override or `utils.NetId`. */
  readonly networkId: string;
  /** `utils.Config.Storage.Image`, already resolved/pulled by the caller (`image-prepull.ts`). */
  readonly image: string;
  readonly targetMigration: string;
  readonly fileSizeLimit: CliConfig["storage"]["file_size_limit"];
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
 * Builds the `docker create` spec for the Storage container. `binds` mounts
 * the container's own named volume at `/mnt` — no `ports`/`exposedPorts`,
 * Storage is reached only via its Docker network alias.
 */
export function legacyBuildStorageContainerSpec(
  input: LegacyStorageContainerSpecInput,
): LegacyStartContainerSpec {
  const containerName = legacyServiceContainerName("storage", input.projectId);
  const env = {
    ...legacyBuildStorageEnv({
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
    }),
  };

  return {
    image: input.image,
    containerName,
    env,
    binds: [`${containerName}:${LEGACY_STORAGE_DOCKER_PATH}`],
    healthcheck: {
      // "For some reason, localhost resolves to IPv6 address on GitPod which breaks
      // healthcheck." — IPv4 loopback pinned.
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
    // The Storage network alias.
    networkAliases: ["storage"],
    labels: {},
  };
}
