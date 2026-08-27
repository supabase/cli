import { Schema } from "effect";
export declare const ProjectConfigApiAttributesSchema: Schema.Struct<{
    readonly database: Schema.optionalKey<Schema.Struct<{
        readonly major_version: Schema.optionalKey<Schema.Number>;
        readonly ssl_enforced: Schema.optionalKey<Schema.Boolean>;
        readonly network_restrictions: Schema.optionalKey<Schema.Struct<{
            readonly entitlement: Schema.optionalKey<Schema.Unknown>;
            readonly status: Schema.optionalKey<Schema.Unknown>;
            readonly allowed_cidrs: Schema.optionalKey<Schema.$Array<Schema.Struct<{
                readonly address: Schema.optionalKey<Schema.String>;
                readonly type: Schema.optionalKey<Schema.String>;
            }>>>;
            readonly updated_at: Schema.optionalKey<Schema.Unknown>;
            readonly applied_at: Schema.optionalKey<Schema.Unknown>;
        }>>;
        readonly postgres_settings: Schema.optionalKey<Schema.Struct<{
            readonly effective_cache_size: Schema.optionalKey<Schema.String>;
            readonly logical_decoding_work_mem: Schema.optionalKey<Schema.String>;
            readonly log_autovacuum_min_duration: Schema.optionalKey<Schema.Unknown>;
            readonly log_checkpoints: Schema.optionalKey<Schema.Unknown>;
            readonly log_connections: Schema.optionalKey<Schema.Unknown>;
            readonly log_disconnections: Schema.optionalKey<Schema.Unknown>;
            readonly log_duration: Schema.optionalKey<Schema.Unknown>;
            readonly log_lock_waits: Schema.optionalKey<Schema.Unknown>;
            readonly log_recovery_conflict_waits: Schema.optionalKey<Schema.Unknown>;
            readonly log_replication_commands: Schema.optionalKey<Schema.Unknown>;
            readonly log_startup_progress_interval: Schema.optionalKey<Schema.Unknown>;
            readonly log_temp_files: Schema.optionalKey<Schema.Unknown>;
            readonly maintenance_work_mem: Schema.optionalKey<Schema.String>;
            readonly track_activity_query_size: Schema.optionalKey<Schema.String>;
            readonly max_connections: Schema.optionalKey<Schema.Number>;
            readonly max_locks_per_transaction: Schema.optionalKey<Schema.Number>;
            readonly max_logical_replication_workers: Schema.optionalKey<Schema.Unknown>;
            readonly max_parallel_maintenance_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers_per_gather: Schema.optionalKey<Schema.Number>;
            readonly max_replication_slots: Schema.optionalKey<Schema.Number>;
            readonly max_slot_wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly max_standby_archive_delay: Schema.optionalKey<Schema.String>;
            readonly max_standby_streaming_delay: Schema.optionalKey<Schema.String>;
            readonly max_sync_workers_per_subscription: Schema.optionalKey<Schema.Unknown>;
            readonly max_wal_size: Schema.optionalKey<Schema.String>;
            readonly max_wal_senders: Schema.optionalKey<Schema.Number>;
            readonly max_worker_processes: Schema.optionalKey<Schema.Number>;
            readonly session_replication_role: Schema.optionalKey<Schema.String>;
            readonly shared_buffers: Schema.optionalKey<Schema.String>;
            readonly statement_timeout: Schema.optionalKey<Schema.String>;
            readonly track_commit_timestamp: Schema.optionalKey<Schema.Boolean>;
            readonly wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly wal_sender_timeout: Schema.optionalKey<Schema.String>;
            readonly work_mem: Schema.optionalKey<Schema.String>;
            readonly checkpoint_timeout: Schema.optionalKey<Schema.Unknown>;
            readonly hot_standby_feedback: Schema.optionalKey<Schema.Unknown>;
            readonly cron_log_statement: Schema.optionalKey<Schema.Unknown>;
        }>>;
    }>>;
    readonly pooler: Schema.optionalKey<Schema.Struct<{
        readonly pool_mode: Schema.optionalKey<Schema.String>;
        readonly ignore_startup_parameters: Schema.optionalKey<Schema.Unknown>;
        readonly server_idle_timeout: Schema.optionalKey<Schema.Unknown>;
        readonly server_lifetime: Schema.optionalKey<Schema.Unknown>;
        readonly query_wait_timeout: Schema.optionalKey<Schema.Unknown>;
        readonly reserve_pool_size: Schema.optionalKey<Schema.Unknown>;
        readonly default_pool_size: Schema.optionalKey<Schema.Number>;
        readonly max_client_conn: Schema.optionalKey<Schema.Number>;
    }>>;
    readonly auth: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    readonly api: Schema.optionalKey<Schema.Struct<{
        readonly db_schema: Schema.optionalKey<Schema.String>;
        readonly db_extra_search_path: Schema.optionalKey<Schema.String>;
        readonly max_rows: Schema.optionalKey<Schema.Number>;
        readonly db_pool_acquisition_timeout: Schema.optionalKey<Schema.Unknown>;
        readonly db_pool: Schema.optionalKey<Schema.Unknown>;
    }>>;
    readonly realtime: Schema.optionalKey<Schema.Struct<{
        readonly private_only: Schema.optionalKey<Schema.Unknown>;
        readonly max_concurrent_users: Schema.optionalKey<Schema.Unknown>;
        readonly max_events_per_second: Schema.optionalKey<Schema.Unknown>;
        readonly max_bytes_per_second: Schema.optionalKey<Schema.Unknown>;
        readonly max_channels_per_client: Schema.optionalKey<Schema.Unknown>;
        readonly max_joins_per_second: Schema.optionalKey<Schema.Unknown>;
        readonly max_presence_events_per_second: Schema.optionalKey<Schema.Unknown>;
        readonly max_payload_size_in_kb: Schema.optionalKey<Schema.Unknown>;
        readonly presence_enabled: Schema.optionalKey<Schema.Unknown>;
        readonly suspend: Schema.optionalKey<Schema.Unknown>;
        readonly connection_pool: Schema.optionalKey<Schema.Unknown>;
        readonly postgres_changes_pool: Schema.optionalKey<Schema.Unknown>;
    }>>;
    readonly storage: Schema.optionalKey<Schema.Struct<{
        readonly file_size_limit: Schema.optionalKey<Schema.Number>;
        readonly features: Schema.optionalKey<Schema.Struct<{
            readonly image_transformation: Schema.optionalKey<Schema.Struct<{
                readonly enabled: Schema.optionalKey<Schema.Boolean>;
            }>>;
            readonly s3_protocol: Schema.optionalKey<Schema.Struct<{
                readonly enabled: Schema.optionalKey<Schema.Boolean>;
            }>>;
            readonly purge_cache: Schema.optionalKey<Schema.Unknown>;
            readonly iceberg_catalog: Schema.optionalKey<Schema.Struct<{
                readonly enabled: Schema.optionalKey<Schema.Boolean>;
                readonly max_namespaces: Schema.optionalKey<Schema.Number>;
                readonly max_tables: Schema.optionalKey<Schema.Number>;
                readonly max_catalogs: Schema.optionalKey<Schema.Number>;
            }>>;
            readonly vector_buckets: Schema.optionalKey<Schema.Struct<{
                readonly enabled: Schema.optionalKey<Schema.Boolean>;
                readonly max_buckets: Schema.optionalKey<Schema.Number>;
                readonly max_indexes: Schema.optionalKey<Schema.Number>;
            }>>;
        }>>;
        readonly capabilities: Schema.optionalKey<Schema.Unknown>;
        readonly upstream_target: Schema.optionalKey<Schema.Unknown>;
        readonly migration_version: Schema.optionalKey<Schema.Unknown>;
        readonly database_pool_mode: Schema.optionalKey<Schema.Unknown>;
    }>>;
}>;
export type ProjectConfigApiAttributes = typeof ProjectConfigApiAttributesSchema.Type;
