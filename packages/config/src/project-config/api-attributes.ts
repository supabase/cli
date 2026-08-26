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
 *   `database.network_restrictions.allowed_cidrs[].type`,
 *   `database.postgres_settings.session_replication_role` — so a new enum
 *   member the platform starts returning never fails decode either.
 * - `auth` is the real contract's own `Schema.Record(Schema.String,
 *   Schema.Json)` (a flat record keyed by lowercased GoTrue setting name) —
 *   already maximally lenient in the real contract, so no widening needed.
 * - **Registry validates, decode only carries the key-set guard.** Every
 *   field this file's sibling registries (`./registry.ts`,
 *   `./registry-auth.ts`) actually map keeps a concrete leaf type — decode
 *   is this package's one chance to reject a genuinely malformed value for a
 *   field it cares about, before the registry's `transform`s run. Every field
 *   with NO registry row is `Schema.optionalKey(Schema.Unknown)` instead: a
 *   platform-side type change on a field this package doesn't map (e.g.
 *   `storage.capabilities.list_v2` growing a third state, `api.db_pool`
 *   changing shape) must never fail this decode, since `fromApiProjectConfig`
 *   is contractually lenient toward exactly that kind of API-ahead-of-package
 *   skew (ADR 0019 rule 2) — a concretely-typed unmapped field would
 *   contradict that contract by turning an irrelevant platform change into a
 *   decode failure for every consumer. `Schema.Unknown` keeps the key
 *   present (rather than dropping the field, which `Schema.Struct`'s default
 *   `onExcessProperty: "ignore"` would do for a field not declared at all) so
 *   the key-set drift guard
 *   (`apps/cli/src/shared/config/project-config-api-drift.unit.test.ts`'s
 *   `AssertNever<Exclude<keyof …, keyof …>>` pairs) still catches the real
 *   contract adding, removing, or renaming that key, and so the raw value is
 *   still reachable at that path for `unmappedApiFields`/`_apiResponse`
 *   passthrough — only its *type* is no longer load-bearing at decode time.
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
 * (including every never-mapped field, now `Schema.Unknown`) so this
 * schema's key set matches the real contract's field-for-field, rather than
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

// Mapped (23 of 38): the STRING-passthrough keys (`DB_SETTINGS_STRING_KEYS`),
// `session_replication_role` (widened to `String`, `sessionReplicationRoleRow`),
// `track_commit_timestamp` (`Boolean`), and the UINT-clamped keys
// (`DB_SETTINGS_UINT_KEYS`) — see `./registry.ts`. Every other key below is
// `Schema.Unknown`: unmapped, per that file's own "Deliberately unmapped"
// comment.
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

// `allowed_cidrs` stays typed — it's mapped (`filterCidrAddresses`,
// `./registry.ts`). `entitlement`/`status`/`updated_at`/`applied_at` are
// unmapped (that file's "Deliberately unmapped" comment).
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

// `pool_mode`/`default_pool_size`/`max_client_conn` stay typed — all three
// are mapped (`./registry.ts`). The other five are unmapped (that file's
// "Deliberately unmapped" comment).
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

// `db_schema`/`db_extra_search_path`/`max_rows` stay typed — all three are
// mapped (`./registry.ts`). `db_pool`/`db_pool_acquisition_timeout` are
// unmapped (that file's "Deliberately unmapped" comment) — including
// `db_pool`, whose real-contract shape is a nullable number: preserving that
// as `Schema.Union([Schema.Number, Schema.Null])` here would still fail
// decode the moment the platform widens it to anything else, exactly the
// hazard this file's unmapped-fields rule exists to avoid, so it is
// `Schema.Unknown` like every other unmapped field rather than a special
// case.
const apiAttributes = Schema.Struct({
  db_schema: Schema.optionalKey(Schema.String),
  db_extra_search_path: Schema.optionalKey(Schema.String),
  max_rows: Schema.optionalKey(Schema.Number),
  db_pool_acquisition_timeout: Schema.optionalKey(Schema.Unknown),
  db_pool: Schema.optionalKey(Schema.Unknown),
});

// Zero rows map any `realtime.*` field (`./registry.ts`'s "=== realtime
// ===" comment) — every field is `Schema.Unknown`. The keys themselves stay
// declared (rather than dropping the whole section) so the key-set drift
// guard still catches the real contract adding/removing/renaming one of
// them.
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

// `purge_cache` is unmapped (`./registry.ts`'s "Deliberately unmapped"
// comment) — collapsed to `Schema.Unknown` rather than kept as a nested
// `{enabled}` struct, same rule as every other unmapped field.
// `image_transformation`/`s3_protocol`/`iceberg_catalog`/`vector_buckets` all
// stay typed — every field inside them is mapped.
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

// Unmapped in full (`./registry.ts`'s "Deliberately unmapped" comment) —
// collapsed to `Schema.Unknown` rather than kept as a `{list_v2,
// iceberg_catalog}` struct, same rule as every other unmapped field.
const storageCapabilitiesAttributes = Schema.Unknown;

// `file_size_limit` stays typed — mapped. `upstream_target`/
// `migration_version`/`database_pool_mode`/`capabilities` are unmapped
// (`./registry.ts`'s "Deliberately unmapped" comment).
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
