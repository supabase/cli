import type { ManagedConfigProperty } from "./config-diff.ts";
import { AUTH_MANAGED_CONFIG_PROPERTIES } from "./config-diff.auth.ts";
import {
  isRemoteRecord,
  managedScalar,
  managedStringList,
  normalizeByteSize,
  remoteValueAt,
  type RemoteScalarKind,
} from "./config-diff.read.ts";

/**
 * The managed surface: every local schema path the v2 project-config resource
 * can report, with its reader. A local path with no entry here is unmanaged by
 * construction — `[studio]`, `[local_smtp]`, ports, image pins, TLS material,
 * `db.migrations`/`db.seed`, `storage.buckets` content, and the entire local
 * `[realtime]` section (its local fields — `enabled`, `ip_version`,
 * `max_header_length` — configure the local container only; none of the v2
 * `realtime` block's platform limits have a config.toml counterpart).
 */

const API_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  managedStringList({ path: "api.schemas", block: "api", remotePath: ["db_schema"] }),
  managedStringList({
    path: "api.extra_search_path",
    block: "api",
    remotePath: ["db_extra_search_path"],
  }),
  managedScalar({ path: "api.max_rows", block: "api", remotePath: ["max_rows"], kind: "number" }),
];

/**
 * `db.settings.*` ↔ `database.postgres_settings.*`. The wire block carries
 * more settings than the local schema declares; only locally-representable
 * ones are managed. Kinds mirror `db.ts`'s `settings` struct.
 */
const POSTGRES_SETTINGS: ReadonlyArray<readonly [name: string, kind: RemoteScalarKind]> = [
  ["effective_cache_size", "string"],
  ["logical_decoding_work_mem", "string"],
  ["maintenance_work_mem", "string"],
  ["max_connections", "number"],
  ["max_locks_per_transaction", "number"],
  ["max_parallel_maintenance_workers", "number"],
  ["max_parallel_workers", "number"],
  ["max_parallel_workers_per_gather", "number"],
  ["max_replication_slots", "number"],
  ["max_slot_wal_keep_size", "string"],
  ["max_standby_archive_delay", "string"],
  ["max_standby_streaming_delay", "string"],
  ["max_wal_size", "string"],
  ["max_wal_senders", "number"],
  ["max_worker_processes", "number"],
  ["session_replication_role", "string"],
  ["shared_buffers", "string"],
  ["statement_timeout", "string"],
  ["track_activity_query_size", "string"],
  ["track_commit_timestamp", "boolean"],
  ["wal_keep_size", "string"],
  ["wal_sender_timeout", "string"],
  ["work_mem", "string"],
];

function readAllowedCidrs(kind: "v4" | "v6") {
  return (remote: Parameters<ManagedConfigProperty["read"]>[0]): unknown => {
    const entries = remoteValueAt(remote, "database", ["network_restrictions", "allowed_cidrs"]);
    if (!Array.isArray(entries)) {
      return undefined;
    }
    return entries
      .filter(isRemoteRecord)
      .filter((entry) => entry["type"] === kind)
      .map((entry) => entry["address"])
      .filter((address): address is string => typeof address === "string");
  };
}

const DATABASE_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  managedScalar({
    path: "db.ssl_enforcement.enabled",
    block: "database",
    remotePath: ["ssl_enforced"],
    kind: "boolean",
  }),
  {
    path: "db.network_restrictions.allowed_cidrs",
    block: "database",
    read: readAllowedCidrs("v4"),
  },
  {
    path: "db.network_restrictions.allowed_cidrs_v6",
    block: "database",
    read: readAllowedCidrs("v6"),
  },
  ...POSTGRES_SETTINGS.map(([name, kind]) =>
    managedScalar({
      path: `db.settings.${name}`,
      block: "database",
      remotePath: ["postgres_settings", name],
      kind,
    }),
  ),
];

const POOLER_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  managedScalar({
    path: "db.pooler.pool_mode",
    block: "pooler",
    remotePath: ["pool_mode"],
    kind: "string",
  }),
  managedScalar({
    path: "db.pooler.default_pool_size",
    block: "pooler",
    remotePath: ["default_pool_size"],
    kind: "number",
  }),
  managedScalar({
    path: "db.pooler.max_client_conn",
    block: "pooler",
    remotePath: ["max_client_conn"],
    kind: "number",
  }),
];

const STORAGE_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  managedScalar({
    path: "storage.file_size_limit",
    block: "storage",
    remotePath: ["file_size_limit"],
    kind: "string",
    normalize: normalizeByteSize,
  }),
  managedScalar({
    path: "storage.image_transformation.enabled",
    block: "storage",
    remotePath: ["features", "image_transformation", "enabled"],
    kind: "boolean",
  }),
  managedScalar({
    path: "storage.s3_protocol.enabled",
    block: "storage",
    remotePath: ["features", "s3_protocol", "enabled"],
    kind: "boolean",
  }),
  managedScalar({
    path: "storage.analytics.enabled",
    block: "storage",
    remotePath: ["features", "iceberg_catalog", "enabled"],
    kind: "boolean",
  }),
  managedScalar({
    path: "storage.analytics.max_namespaces",
    block: "storage",
    remotePath: ["features", "iceberg_catalog", "max_namespaces"],
    kind: "number",
  }),
  managedScalar({
    path: "storage.analytics.max_tables",
    block: "storage",
    remotePath: ["features", "iceberg_catalog", "max_tables"],
    kind: "number",
  }),
  managedScalar({
    path: "storage.analytics.max_catalogs",
    block: "storage",
    remotePath: ["features", "iceberg_catalog", "max_catalogs"],
    kind: "number",
  }),
  managedScalar({
    path: "storage.vector.enabled",
    block: "storage",
    remotePath: ["features", "vector_buckets", "enabled"],
    kind: "boolean",
  }),
  managedScalar({
    path: "storage.vector.max_buckets",
    block: "storage",
    remotePath: ["features", "vector_buckets", "max_buckets"],
    kind: "number",
  }),
  managedScalar({
    path: "storage.vector.max_indexes",
    block: "storage",
    remotePath: ["features", "vector_buckets", "max_indexes"],
    kind: "number",
  }),
];

export const MANAGED_CONFIG_PROPERTIES: ReadonlyArray<ManagedConfigProperty> = [
  ...API_PROPERTIES,
  ...AUTH_MANAGED_CONFIG_PROPERTIES,
  ...DATABASE_PROPERTIES,
  ...POOLER_PROPERTIES,
  ...STORAGE_PROPERTIES,
];

/** Dotted local schema paths of the managed surface. */
export const MANAGED_CONFIG_PATHS: ReadonlySet<string> = new Set(
  MANAGED_CONFIG_PROPERTIES.map((property) => property.path),
);
