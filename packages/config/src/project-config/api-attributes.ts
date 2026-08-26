import { Schema } from "effect";

/**
 * A deliberately lenient mirror of the Management API v2 project-config
 * resource's `data.attributes` shape (`packages/api/src/generated/
 * contracts.ts:10809-11402`, `V2GetProjectConfigOutput`). Hand-mirrored
 * rather than imported from `packages/api`: `@supabase/config` must not
 * depend on `packages/api` (CLI-2230's decoupling requirement — the config
 * package ships to npm on its own, independent of the generated API client).
 *
 * Leniency, per ADR 0019 rule 2 ("lenient decode, applied before the strict
 * generated schema sees the body"):
 * - Every section and every field is `Schema.optionalKey`, all the way down —
 *   an API-ahead-of-package field the package doesn't know about yet is
 *   simply absent from the decoded value, never a decode failure.
 * - No range/pattern checks (`isInt`, `isGreaterThanOrEqualTo`, `isPattern`,
 *   …) even where the real contract has them: an out-of-range or
 *   differently-shaped value must still decode and reach the mapping layer,
 *   which is the thing actually responsible for narrowing it.
 * - Closed string unions in the real contract (`Schema.Literals`) are widened
 *   to plain `Schema.String` here — `pooler.pool_mode`,
 *   `database.network_restrictions.{entitlement,status}`,
 *   `database.network_restrictions.allowed_cidrs[].type`,
 *   `database.postgres_settings.session_replication_role`,
 *   `storage.upstream_target` — so a new enum member the platform starts
 *   returning never fails decode either. The two nullable numeric unions in
 *   the real contract (`api.db_pool`, `realtime.postgres_changes_pool`) are
 *   preserved as `Schema.Union([Schema.Number, Schema.Null])`: nullability
 *   there is a meaningful tri-state (`null` = "no override stored"), not a
 *   closed enum that could grow a new member.
 * - `auth` is the real contract's own `Schema.Record(Schema.String,
 *   Schema.Json)` (a flat record keyed by lowercased GoTrue setting name) —
 *   already maximally lenient in the real contract, so no widening needed.
 *
 * Excess top-level/nested keys beyond what's declared below are silently
 * dropped, not rejected: Effect v4's `Schema.Struct` decode defaults
 * `onExcessProperty` to `"ignore"` (`.repos/effect/packages/effect/src/
 * SchemaAST.ts:446,477-483`), so a plain `Schema.decodeUnknownSync` call
 * needs no extra options to get this behavior. Tolerated keys are not lost,
 * though — `fromApiProjectConfig` (`./project-config.ts`) attaches the raw,
 * pre-decode attributes object verbatim as `_apiResponse` (ADR 0019 rule 1),
 * so `unmappedApiFields` can still see them.
 *
 * Every field from the real contract's six sections is mirrored below
 * (including fields the registry never maps, e.g. `postgres_settings`'s
 * ~15 unmapped keys, all of `realtime`, `storage.capabilities`) so this
 * schema's shape matches the real contract's field-for-field, rather than
 * being pieced together from a hand-maintained comment.
 *
 * This shape is also the operand of the type-level assignability guard in
 * `apps/cli/src/shared/config/project-config-api-drift.unit.test.ts`
 * (`_typeDriftGuard`), but that guard only catches the real contract
 * *widening* a field's type out from under this deliberately narrower mirror
 * — a field the real contract adds, removes, or renames passes an
 * assignability check silently, since TypeScript structural assignability
 * doesn't require the source type to have no extra/differently-named
 * properties. That same test file's type-level key-set assertions
 * (`AssertNever<Exclude<keyof …, keyof …>>`, one pair per nesting level) are
 * the guard against additions, removals, and renames; this schema's job is
 * only to stay a faithful, maximally-lenient mirror of whatever shape those
 * two guards jointly pin down.
 */

const postgresSettingsAttributes = Schema.Struct({
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  log_autovacuum_min_duration: Schema.optionalKey(Schema.String),
  log_checkpoints: Schema.optionalKey(Schema.Boolean),
  log_connections: Schema.optionalKey(Schema.Boolean),
  log_disconnections: Schema.optionalKey(Schema.Boolean),
  log_duration: Schema.optionalKey(Schema.Boolean),
  log_lock_waits: Schema.optionalKey(Schema.Boolean),
  log_recovery_conflict_waits: Schema.optionalKey(Schema.Boolean),
  log_replication_commands: Schema.optionalKey(Schema.Boolean),
  log_startup_progress_interval: Schema.optionalKey(Schema.String),
  log_temp_files: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(Schema.Number),
  max_locks_per_transaction: Schema.optionalKey(Schema.Number),
  max_logical_replication_workers: Schema.optionalKey(Schema.Number),
  max_parallel_maintenance_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers_per_gather: Schema.optionalKey(Schema.Number),
  max_replication_slots: Schema.optionalKey(Schema.Number),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_sync_workers_per_subscription: Schema.optionalKey(Schema.Number),
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
  checkpoint_timeout: Schema.optionalKey(Schema.String),
  hot_standby_feedback: Schema.optionalKey(Schema.Boolean),
  cron_log_statement: Schema.optionalKey(Schema.Boolean),
});

const networkRestrictionsAttributes = Schema.Struct({
  entitlement: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  allowed_cidrs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        address: Schema.optionalKey(Schema.String),
        type: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  updated_at: Schema.optionalKey(Schema.String),
  applied_at: Schema.optionalKey(Schema.String),
});

const databaseAttributes = Schema.Struct({
  major_version: Schema.optionalKey(Schema.Number),
  ssl_enforced: Schema.optionalKey(Schema.Boolean),
  network_restrictions: Schema.optionalKey(networkRestrictionsAttributes),
  postgres_settings: Schema.optionalKey(postgresSettingsAttributes),
});

const poolerAttributes = Schema.Struct({
  pool_mode: Schema.optionalKey(Schema.String),
  ignore_startup_parameters: Schema.optionalKey(Schema.String),
  server_idle_timeout: Schema.optionalKey(Schema.Number),
  server_lifetime: Schema.optionalKey(Schema.Number),
  query_wait_timeout: Schema.optionalKey(Schema.Number),
  reserve_pool_size: Schema.optionalKey(Schema.Number),
  default_pool_size: Schema.optionalKey(Schema.Number),
  max_client_conn: Schema.optionalKey(Schema.Number),
});

const apiAttributes = Schema.Struct({
  db_schema: Schema.optionalKey(Schema.String),
  db_extra_search_path: Schema.optionalKey(Schema.String),
  max_rows: Schema.optionalKey(Schema.Number),
  db_pool_acquisition_timeout: Schema.optionalKey(Schema.Number),
  db_pool: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
});

const realtimeAttributes = Schema.Struct({
  private_only: Schema.optionalKey(Schema.Boolean),
  max_concurrent_users: Schema.optionalKey(Schema.Number),
  max_events_per_second: Schema.optionalKey(Schema.Number),
  max_bytes_per_second: Schema.optionalKey(Schema.Number),
  max_channels_per_client: Schema.optionalKey(Schema.Number),
  max_joins_per_second: Schema.optionalKey(Schema.Number),
  max_presence_events_per_second: Schema.optionalKey(Schema.Number),
  max_payload_size_in_kb: Schema.optionalKey(Schema.Number),
  presence_enabled: Schema.optionalKey(Schema.Boolean),
  suspend: Schema.optionalKey(Schema.Boolean),
  connection_pool: Schema.optionalKey(Schema.Number),
  postgres_changes_pool: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Null])),
});

const storageFeaturesAttributes = Schema.Struct({
  image_transformation: Schema.optionalKey(
    Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
  ),
  s3_protocol: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
  purge_cache: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
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

const storageCapabilitiesAttributes = Schema.Struct({
  list_v2: Schema.optionalKey(Schema.Boolean),
  iceberg_catalog: Schema.optionalKey(Schema.Boolean),
});

const storageAttributes = Schema.Struct({
  file_size_limit: Schema.optionalKey(Schema.Number),
  features: Schema.optionalKey(storageFeaturesAttributes),
  capabilities: Schema.optionalKey(storageCapabilitiesAttributes),
  upstream_target: Schema.optionalKey(Schema.String),
  migration_version: Schema.optionalKey(Schema.String),
  database_pool_mode: Schema.optionalKey(Schema.String),
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
