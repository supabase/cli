import { Schema } from "effect";
export declare const db: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly shadow_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly health_timeout: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly major_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly pooler: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly pool_mode: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly default_pool_size: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly max_client_conn: Schema.withDecodingDefaultKey<Schema.Number, never>;
    }>, never>;
    readonly migrations: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly schema_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    }>, never>;
    readonly seed: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly sql_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    }>, never>;
    readonly settings: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly effective_cache_size: Schema.optionalKey<Schema.String>;
        readonly logical_decoding_work_mem: Schema.optionalKey<Schema.String>;
        readonly maintenance_work_mem: Schema.optionalKey<Schema.String>;
        readonly max_connections: Schema.optionalKey<Schema.Number>;
        readonly max_locks_per_transaction: Schema.optionalKey<Schema.Number>;
        readonly max_parallel_maintenance_workers: Schema.optionalKey<Schema.Number>;
        readonly max_parallel_workers: Schema.optionalKey<Schema.Number>;
        readonly max_parallel_workers_per_gather: Schema.optionalKey<Schema.Number>;
        readonly max_replication_slots: Schema.optionalKey<Schema.Number>;
        readonly max_slot_wal_keep_size: Schema.optionalKey<Schema.String>;
        readonly max_standby_archive_delay: Schema.optionalKey<Schema.String>;
        readonly max_standby_streaming_delay: Schema.optionalKey<Schema.String>;
        readonly max_wal_size: Schema.optionalKey<Schema.String>;
        readonly max_wal_senders: Schema.optionalKey<Schema.Number>;
        readonly max_worker_processes: Schema.optionalKey<Schema.Number>;
        readonly session_replication_role: Schema.optionalKey<Schema.Literals<string[]>>;
        readonly shared_buffers: Schema.optionalKey<Schema.String>;
        readonly statement_timeout: Schema.optionalKey<Schema.String>;
        readonly track_activity_query_size: Schema.optionalKey<Schema.String>;
        readonly track_commit_timestamp: Schema.optionalKey<Schema.Boolean>;
        readonly wal_keep_size: Schema.optionalKey<Schema.String>;
        readonly wal_sender_timeout: Schema.optionalKey<Schema.String>;
        readonly work_mem: Schema.optionalKey<Schema.String>;
    }>, never>>;
    readonly network_restrictions: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly allowed_cidrs: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly allowed_cidrs_v6: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    }>, never>;
    readonly ssl_enforcement: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>>;
    readonly vault: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
}>, never>;
