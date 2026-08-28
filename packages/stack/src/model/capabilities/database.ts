import { Schema } from "effect";
import { identityMaterialize, workload, type CapabilityModule } from "../CapabilityModule.ts";

const settingsFields = {
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(Schema.Finite),
  max_locks_per_transaction: Schema.optionalKey(Schema.Finite),
  max_parallel_maintenance_workers: Schema.optionalKey(Schema.Finite),
  max_parallel_workers: Schema.optionalKey(Schema.Finite),
  max_parallel_workers_per_gather: Schema.optionalKey(Schema.Finite),
  max_replication_slots: Schema.optionalKey(Schema.Finite),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Finite),
  max_worker_processes: Schema.optionalKey(Schema.Finite),
  session_replication_role: Schema.optionalKey(
    Schema.Literals(["origin", "replica", "local"] as const),
  ),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(Schema.String),
  work_mem: Schema.optionalKey(Schema.String),
};

const settingsSchema = Schema.Struct(settingsFields);
const networkSchema = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.String)),
  allowed_cidrs_v6: Schema.optionalKey(Schema.Array(Schema.String)),
});
const sslSchema = Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) });

export const DatabaseSettingsSchema = Schema.Struct({
  health_timeout: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(settingsSchema),
  network_restrictions: Schema.optionalKey(networkSchema),
  ssl_enforcement: Schema.optionalKey(sslSchema),
  vault: Schema.optionalKey(Schema.Record(Schema.String, Schema.Redacted(Schema.String))),
});
export type DatabaseSettings = Schema.Schema.Type<typeof DatabaseSettingsSchema>;

const defaults: DatabaseSettings = {
  health_timeout: "2m",
  settings: {
    effective_cache_size: undefined,
    logical_decoding_work_mem: undefined,
    maintenance_work_mem: undefined,
    max_connections: undefined,
    max_locks_per_transaction: undefined,
    max_parallel_maintenance_workers: undefined,
    max_parallel_workers: undefined,
    max_parallel_workers_per_gather: undefined,
    max_replication_slots: undefined,
    max_slot_wal_keep_size: undefined,
    max_standby_archive_delay: undefined,
    max_standby_streaming_delay: undefined,
    max_wal_size: undefined,
    max_wal_senders: undefined,
    max_worker_processes: undefined,
    session_replication_role: undefined,
    shared_buffers: undefined,
    statement_timeout: undefined,
    track_activity_query_size: undefined,
    track_commit_timestamp: undefined,
    wal_keep_size: undefined,
    wal_sender_timeout: undefined,
    work_mem: undefined,
  },
  network_restrictions: {
    enabled: false,
    allowed_cidrs: ["0.0.0.0/0"],
    allowed_cidrs_v6: ["::/0"],
  },
  ssl_enforcement: { enabled: false },
  vault: {},
};

export const DatabaseModule: CapabilityModule<DatabaseSettings> = {
  name: "database",
  settings: DatabaseSettingsSchema,
  defaultSettings: defaults,
  defaultEnabled: true,
  defaultActivation: "eager",
  dependencies: [],
  workloads: [
    workload("database", "database", "17.6.1.165", "supabase/postgres:17.6.1.165", {
      readiness: { mode: "tcp", portField: "database" },
    }),
    workload("database-bootstrap", "database", "17.6.1.165", "supabase/postgres:17.6.1.165", {
      dependencies: ["database:database"],
      readiness: { mode: "tcp", portField: "database" },
    }),
  ],
  routes: [{ listener: "database", protocol: "tcp" }],
  materialize: (settings) => identityMaterialize(settings),
  runtimeArtifact: (entry, runtime) =>
    runtime.kind === "native" ? entry.artifacts.native : entry.artifacts.container,
};

export const DatabaseVersionMap = {
  "13": "13.3.0",
  "14": "14.1.0.89",
  "15": "15.8.1.085",
  "16": "16.4.0.0",
  "17": "17.6.1.165",
  "13.3.0": "13.3.0",
  "14.1.0.89": "14.1.0.89",
  "15.8.1.085": "15.8.1.085",
  "16.4.0.0": "16.4.0.0",
  "17.6.1.165": "17.6.1.165",
} as const;
