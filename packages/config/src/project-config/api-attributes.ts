import { Schema } from "effect";

/**
 * A lenient, hand-mirrored copy of the v2 project-config API's `data.attributes` shape (not
 * imported from `packages/api`, so this package has no dependency on the generated client).
 * Every field is optional, unranged, and never a closed union, so an API-ahead-of-package value
 * always decodes; `./registry.ts`/`./registry-auth.ts` narrow and map it. Unmapped fields stay
 * `Schema.Unknown`, not omitted, so drift detection and passthrough can still see them.
 */

// See `./registry.ts` for which of these fields are mapped; the rest are `Schema.Unknown`.
const postgresSettingsAttributes = Schema.Struct({
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  log_autovacuum_min_duration: Schema.optionalKey(Schema.Unknown),
  log_checkpoints: Schema.optionalKey(Schema.Unknown),
  log_connections: Schema.optionalKey(Schema.Unknown),
  log_disconnections: Schema.optionalKey(Schema.Unknown),
  log_duration: Schema.optionalKey(Schema.Unknown),
  log_lock_waits: Schema.optionalKey(Schema.Unknown),
  log_recovery_conflict_waits: Schema.optionalKey(Schema.Unknown),
  log_replication_commands: Schema.optionalKey(Schema.Unknown),
  log_startup_progress_interval: Schema.optionalKey(Schema.Unknown),
  log_temp_files: Schema.optionalKey(Schema.Unknown),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(Schema.Number),
  max_locks_per_transaction: Schema.optionalKey(Schema.Number),
  max_logical_replication_workers: Schema.optionalKey(Schema.Unknown),
  max_parallel_maintenance_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers_per_gather: Schema.optionalKey(Schema.Number),
  max_replication_slots: Schema.optionalKey(Schema.Number),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_sync_workers_per_subscription: Schema.optionalKey(Schema.Unknown),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Number),
  max_worker_processes: Schema.optionalKey(Schema.Number),
  session_replication_role: Schema.optionalKey(Schema.String),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(Schema.String),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(Schema.String),
  work_mem: Schema.optionalKey(Schema.String),
  checkpoint_timeout: Schema.optionalKey(Schema.Unknown),
  hot_standby_feedback: Schema.optionalKey(Schema.Unknown),
  cron_log_statement: Schema.optionalKey(Schema.Unknown),
});

// `allowed_cidrs` is mapped (`filterCidrAddresses`, `./registry.ts`); the rest are unmapped.
const networkRestrictionsAttributes = Schema.Struct({
  entitlement: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.Unknown),
  allowed_cidrs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        address: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  updated_at: Schema.optionalKey(Schema.Unknown),
  applied_at: Schema.optionalKey(Schema.Unknown),
});

const databaseAttributes = Schema.Struct({
  major_version: Schema.optionalKey(Schema.Number),
  ssl_enforced: Schema.optionalKey(Schema.Boolean),
  network_restrictions: Schema.optionalKey(networkRestrictionsAttributes),
  postgres_settings: Schema.optionalKey(postgresSettingsAttributes),
});

// `pool_mode`/`default_pool_size`/`max_client_conn` are mapped (`./registry.ts`); the rest aren't.
const poolerAttributes = Schema.Struct({
  pool_mode: Schema.optionalKey(Schema.String),
  ignore_startup_parameters: Schema.optionalKey(Schema.Unknown),
  server_idle_timeout: Schema.optionalKey(Schema.Unknown),
  server_lifetime: Schema.optionalKey(Schema.Unknown),
  query_wait_timeout: Schema.optionalKey(Schema.Unknown),
  reserve_pool_size: Schema.optionalKey(Schema.Unknown),
  default_pool_size: Schema.optionalKey(Schema.Number),
  max_client_conn: Schema.optionalKey(Schema.Number),
});

// `db_schema`/`db_extra_search_path`/`max_rows` are mapped (`./registry.ts`); the rest aren't.
// `db_pool`'s real shape is a nullable number, but it stays `Schema.Unknown` like every other
// unmapped field rather than a more precise type that could fail decode if the platform widens it.
const apiAttributes = Schema.Struct({
  db_schema: Schema.optionalKey(Schema.String),
  db_extra_search_path: Schema.optionalKey(Schema.String),
  max_rows: Schema.optionalKey(Schema.Number),
  db_pool_acquisition_timeout: Schema.optionalKey(Schema.Unknown),
  db_pool: Schema.optionalKey(Schema.Unknown),
});

// No `realtime.*` field is mapped; keys stay declared as `Schema.Unknown` (rather than dropping
// the section) so the drift guard still catches the API adding, removing, or renaming one.
const realtimeAttributes = Schema.Struct({
  private_only: Schema.optionalKey(Schema.Unknown),
  max_concurrent_users: Schema.optionalKey(Schema.Unknown),
  max_events_per_second: Schema.optionalKey(Schema.Unknown),
  max_bytes_per_second: Schema.optionalKey(Schema.Unknown),
  max_channels_per_client: Schema.optionalKey(Schema.Unknown),
  max_joins_per_second: Schema.optionalKey(Schema.Unknown),
  max_presence_events_per_second: Schema.optionalKey(Schema.Unknown),
  max_payload_size_in_kb: Schema.optionalKey(Schema.Unknown),
  presence_enabled: Schema.optionalKey(Schema.Unknown),
  suspend: Schema.optionalKey(Schema.Unknown),
  connection_pool: Schema.optionalKey(Schema.Unknown),
  postgres_changes_pool: Schema.optionalKey(Schema.Unknown),
});

// `image_transformation`/`s3_protocol`/`iceberg_catalog`/`vector_buckets` are fully mapped;
// `purge_cache` is unmapped and collapsed to `Schema.Unknown` like every other unmapped field.
const storageFeaturesAttributes = Schema.Struct({
  image_transformation: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
  ),
  s3_protocol: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
  purge_cache: Schema.optionalKey(Schema.Unknown),
  iceberg_catalog: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      max_namespaces: Schema.optionalKey(Schema.Number),
      max_tables: Schema.optionalKey(Schema.Number),
      max_catalogs: Schema.optionalKey(Schema.Number),
    }),
  ),
  vector_buckets: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      max_buckets: Schema.optionalKey(Schema.Number),
      max_indexes: Schema.optionalKey(Schema.Number),
    }),
  ),
});

// Unmapped in full; collapsed to `Schema.Unknown` rather than kept as a `{list_v2,
// iceberg_catalog}` struct, like every other unmapped field.
const storageCapabilitiesAttributes = Schema.Unknown;

// `file_size_limit` is mapped; `capabilities`/`upstream_target`/`migration_version`/
// `database_pool_mode` aren't.
const storageAttributes = Schema.Struct({
  file_size_limit: Schema.optionalKey(Schema.Number),
  features: Schema.optionalKey(storageFeaturesAttributes),
  capabilities: Schema.optionalKey(storageCapabilitiesAttributes),
  upstream_target: Schema.optionalKey(Schema.Unknown),
  migration_version: Schema.optionalKey(Schema.Unknown),
  database_pool_mode: Schema.optionalKey(Schema.Unknown),
});

export const ProjectConfigApiAttributesSchema = Schema.Struct({
  database: Schema.optionalKey(databaseAttributes),
  pooler: Schema.optionalKey(poolerAttributes),
  auth: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  api: Schema.optionalKey(apiAttributes),
  realtime: Schema.optionalKey(realtimeAttributes),
  storage: Schema.optionalKey(storageAttributes),
});

export type ProjectConfigApiAttributes = typeof ProjectConfigApiAttributesSchema.Type;

/**
 * The per-service block keys of the v2 project-config `data.attributes`, in alphabetical order —
 * derived from this schema's own key set so consumers never hand-copy a list that could go stale.
 */
export const projectConfigApiBlockKeys: ReadonlyArray<string> = Object.keys(
  ProjectConfigApiAttributesSchema.fields,
).sort();
