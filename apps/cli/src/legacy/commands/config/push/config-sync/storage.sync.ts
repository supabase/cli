import type { ProjectConfig } from "@supabase/config";

import { diff } from "./config-sync.diff.ts";
import { encodeToml, type TomlField, type TomlValue } from "./config-sync.toml.ts";
import { bytesSize, intToUint, ramInBytes } from "../../../../shared/legacy-size-units.ts";

/**
 * Push-subset of Go's `storage` struct (`pkg/config/storage.go`). `toml:"-"`
 * locals (image, imgproxy, s3 credentials) are excluded. `file_size_limit`
 * fields are `sizeInBytes` → serialised as a quoted `BytesSize` string.
 */

interface ImageTransformationSubset {
  readonly enabled: boolean;
}

interface S3ProtocolSubset {
  readonly enabled: boolean;
}

interface BucketSubset {
  readonly public: boolean | undefined;
  /** bytes (re-serialised via BytesSize). */
  readonly file_size_limit: number;
  readonly allowed_mime_types: ReadonlyArray<string>;
  readonly objects_path: string;
}

interface BucketsCountSubset {
  readonly enabled: boolean;
  readonly buckets: ReadonlyArray<string>;
}

export interface StorageSubset {
  readonly enabled: boolean;
  /** bytes (re-serialised via BytesSize). */
  readonly file_size_limit: number;
  readonly image_transformation: ImageTransformationSubset | undefined;
  readonly s3_protocol: S3ProtocolSubset | undefined;
  readonly buckets: Readonly<Record<string, BucketSubset>> | undefined;
  readonly analytics: BucketsCountSubset & {
    readonly max_namespaces: number;
    readonly max_tables: number;
    readonly max_catalogs: number;
  };
  readonly vector: BucketsCountSubset & {
    readonly max_buckets: number;
    readonly max_indexes: number;
  };
}

const BUCKET_FIELDS: ReadonlyArray<TomlField> = [
  { key: "public", node: { kind: "bool" } },
  { key: "file_size_limit", node: { kind: "string" } },
  { key: "allowed_mime_types", node: { kind: "array", elem: { kind: "string" } } },
  { key: "objects_path", node: { kind: "string" } },
];

const STORAGE_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "file_size_limit", node: { kind: "string" } },
  {
    key: "image_transformation",
    node: { kind: "struct", fields: [{ key: "enabled", node: { kind: "bool" } }] },
  },
  {
    key: "s3_protocol",
    node: { kind: "struct", fields: [{ key: "enabled", node: { kind: "bool" } }] },
  },
  { key: "buckets", node: { kind: "map", value: { kind: "struct", fields: BUCKET_FIELDS } } },
  {
    key: "analytics",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "max_namespaces", node: { kind: "int" } },
        { key: "max_tables", node: { kind: "int" } },
        { key: "max_catalogs", node: { kind: "int" } },
        { key: "buckets", node: { kind: "set" } },
      ],
    },
  },
  {
    key: "vector",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "max_buckets", node: { kind: "int" } },
        { key: "max_indexes", node: { kind: "int" } },
        { key: "buckets", node: { kind: "set" } },
      ],
    },
  },
];

/** Remote `V1GetStorageConfig` response (subset Go reads). */
export interface RemoteStorageConfig {
  readonly fileSizeLimit: number;
  readonly features: {
    readonly imageTransformation: { readonly enabled: boolean };
    readonly s3Protocol: { readonly enabled: boolean };
    readonly icebergCatalog: {
      readonly enabled: boolean;
      readonly maxNamespaces: number;
      readonly maxTables: number;
      readonly maxCatalogs: number;
    };
    readonly vectorBuckets: {
      readonly enabled: boolean;
      readonly maxBuckets: number;
      readonly maxIndexes: number;
    };
  };
}

/** Which optional `*pointer` storage sections are declared in the raw config. */
export interface StoragePresence {
  readonly imageTransformation: boolean;
  readonly s3Protocol: boolean;
}

/**
 * Projects the loaded `config.storage` into the push subset.
 *
 * Go's `storage.ImageTransformation` and `storage.S3Protocol` are `*pointer`
 * fields (nil unless `[storage.image_transformation]` / `[storage.s3_protocol]`
 * is declared). `@supabase/config` decodes both to a defaulted struct
 * regardless, so `presence` (from raw-TOML key detection) is passed to recover
 * Go's nil-pointer skip semantics — a nil pointer is excluded from the diff and
 * the update body.
 */
export function storageSubsetFromConfig(
  config: ProjectConfig,
  presence: StoragePresence,
): StorageSubset {
  const s = config.storage;
  const buckets =
    s.buckets === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(s.buckets).map(([name, b]) => [
            name,
            {
              public: b.public,
              file_size_limit: ramInBytes(b.file_size_limit),
              allowed_mime_types: b.allowed_mime_types,
              objects_path: b.objects_path,
            } satisfies BucketSubset,
          ]),
        );
  return {
    enabled: s.enabled,
    file_size_limit: ramInBytes(s.file_size_limit),
    image_transformation: presence.imageTransformation
      ? { enabled: s.image_transformation?.enabled ?? false }
      : undefined,
    s3_protocol: presence.s3Protocol ? { enabled: s.s3_protocol.enabled } : undefined,
    buckets,
    analytics: {
      enabled: s.analytics.enabled,
      max_namespaces: s.analytics.max_namespaces,
      max_tables: s.analytics.max_tables,
      max_catalogs: s.analytics.max_catalogs,
      buckets: Object.keys(s.analytics.buckets),
    },
    vector: {
      enabled: s.vector.enabled,
      max_buckets: s.vector.max_buckets,
      max_indexes: s.vector.max_indexes,
      buckets: Object.keys(s.vector.buckets),
    },
  };
}

/** Port of Go `(*storage).FromRemoteStorageConfig`. */
function applyRemoteStorageConfig(
  local: StorageSubset,
  remote: RemoteStorageConfig,
): StorageSubset {
  return {
    ...local,
    file_size_limit: remote.fileSizeLimit,
    image_transformation:
      local.image_transformation === undefined
        ? undefined
        : { enabled: remote.features.imageTransformation.enabled },
    s3_protocol:
      local.s3_protocol === undefined ? undefined : { enabled: remote.features.s3Protocol.enabled },
    analytics: local.analytics.enabled
      ? {
          ...local.analytics,
          enabled: remote.features.icebergCatalog.enabled,
          max_namespaces: intToUint(remote.features.icebergCatalog.maxNamespaces),
          max_tables: intToUint(remote.features.icebergCatalog.maxTables),
          max_catalogs: intToUint(remote.features.icebergCatalog.maxCatalogs),
        }
      : local.analytics,
    vector: local.vector.enabled
      ? {
          ...local.vector,
          enabled: remote.features.vectorBuckets.enabled,
          max_buckets: intToUint(remote.features.vectorBuckets.maxBuckets),
          max_indexes: intToUint(remote.features.vectorBuckets.maxIndexes),
        }
      : local.vector,
  };
}

function bucketToTomlValue(b: BucketSubset): { readonly [k: string]: TomlValue | undefined } {
  return {
    public: b.public,
    file_size_limit: bytesSize(b.file_size_limit),
    allowed_mime_types: b.allowed_mime_types,
    objects_path: b.objects_path,
  };
}

function storageToTomlValue(s: StorageSubset): { readonly [k: string]: TomlValue | undefined } {
  return {
    enabled: s.enabled,
    file_size_limit: bytesSize(s.file_size_limit),
    image_transformation:
      s.image_transformation === undefined
        ? undefined
        : { enabled: s.image_transformation.enabled },
    s3_protocol: s.s3_protocol === undefined ? undefined : { enabled: s.s3_protocol.enabled },
    buckets:
      s.buckets === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(s.buckets).map(([name, b]) => [name, bucketToTomlValue(b)]),
          ),
    analytics: {
      enabled: s.analytics.enabled,
      max_namespaces: s.analytics.max_namespaces,
      max_tables: s.analytics.max_tables,
      max_catalogs: s.analytics.max_catalogs,
      buckets: s.analytics.buckets,
    },
    vector: {
      enabled: s.vector.enabled,
      max_buckets: s.vector.max_buckets,
      max_indexes: s.vector.max_indexes,
      buckets: s.vector.buckets,
    },
  };
}

/** Port of Go `(*storage).DiffWithRemote`. */
export function diffStorageWithRemote(local: StorageSubset, remote: RemoteStorageConfig): string {
  const currentValue = encodeToml(STORAGE_FIELDS, storageToTomlValue(local));
  const remoteCompare = encodeToml(
    STORAGE_FIELDS,
    storageToTomlValue(applyRemoteStorageConfig(local, remote)),
  );
  return diff("remote[storage]", remoteCompare, "local[storage]", currentValue);
}

/** Body for the `V1UpdateStorageConfig` PATCH (Go `ToUpdateStorageConfigBody`). */
export interface StorageUpdateBody {
  readonly fileSizeLimit: number;
  readonly features: {
    icebergCatalog?: {
      readonly enabled: boolean;
      readonly maxCatalogs: number;
      readonly maxNamespaces: number;
      readonly maxTables: number;
    };
    imageTransformation?: { readonly enabled: boolean };
    s3Protocol?: { readonly enabled: boolean };
    vectorBuckets?: {
      readonly enabled: boolean;
      readonly maxBuckets: number;
      readonly maxIndexes: number;
    };
  };
}

/** Port of Go `(*storage).ToUpdateStorageConfigBody`. */
export function storageToUpdateBody(local: StorageSubset): StorageUpdateBody {
  const features: StorageUpdateBody["features"] = {};
  if (local.image_transformation !== undefined) {
    features.imageTransformation = { enabled: local.image_transformation.enabled };
  }
  if (local.analytics.enabled) {
    features.icebergCatalog = {
      enabled: true,
      maxNamespaces: local.analytics.max_namespaces,
      maxTables: local.analytics.max_tables,
      maxCatalogs: local.analytics.max_catalogs,
    };
  }
  if (local.vector.enabled) {
    features.vectorBuckets = {
      enabled: true,
      maxBuckets: local.vector.max_buckets,
      maxIndexes: local.vector.max_indexes,
    };
  }
  if (local.s3_protocol !== undefined) {
    features.s3Protocol = { enabled: local.s3_protocol.enabled };
  }
  return { fileSizeLimit: local.file_size_limit, features };
}
