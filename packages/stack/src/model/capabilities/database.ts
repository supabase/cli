import { Duration, Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";

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

export const DEFAULT_DATABASE_HEALTH_TIMEOUT = "2m";

const MAX_GO_DURATION_NS = 9_223_372_036_854_775_807n;
const GO_DURATION_UNITS = {
  ns: 1n,
  us: 1_000n,
  µs: 1_000n,
  μs: 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
} as const;

/** Parses the Go duration syntax used by persisted database configuration. */
export const parseGoDuration = (value: string): Duration.Duration => {
  const original = value;
  let input = value;
  const negative = input.startsWith("-");
  if (input.startsWith("-") || input.startsWith("+")) input = input.slice(1);
  if (input === "0") return Duration.zero;
  if (input.length === 0) throw new Error(`invalid duration "${original}"`);

  let total = 0n;
  while (input.length > 0) {
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(input);
    if (number === null) throw new Error(`invalid duration "${original}"`);
    const token = number[0];
    const dot = token.indexOf(".");
    const whole = dot === -1 ? token : token.slice(0, dot);
    const fraction = dot === -1 ? "" : token.slice(dot + 1);
    input = input.slice(token.length);

    let unit: keyof typeof GO_DURATION_UNITS | undefined;
    for (const candidate of ["ns", "us", "µs", "μs", "ms", "s", "m", "h"] as const) {
      if (input.startsWith(candidate)) {
        unit = candidate;
        input = input.slice(candidate.length);
        break;
      }
    }
    if (unit === undefined) throw new Error(`invalid duration "${original}"`);
    const unitNs = GO_DURATION_UNITS[unit];
    const wholeNs = BigInt(whole) * unitNs;
    const fractionNs =
      fraction.length === 0 ? 0n : (BigInt(fraction) * unitNs) / 10n ** BigInt(fraction.length);
    total += wholeNs + fractionNs;
    if (total > MAX_GO_DURATION_NS) throw new Error(`duration out of range "${original}"`);
  }
  if (negative) return Duration.nanos(-total);
  return Duration.nanos(total);
};

const defaults: DatabaseSettings = {
  health_timeout: DEFAULT_DATABASE_HEALTH_TIMEOUT,
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

const databaseCatalog = catalogEntryFor("database:database");
const databaseReleases = Object.fromEntries(
  Object.keys(databaseCatalog.releases).flatMap((version) => {
    const selected = release(version, [
      workload("database", "database", {
        bootstrap: "database",
        readiness: { portField: "database" },
        version,
      }),
    ]);
    return [
      [version, selected],
      [version.split(".")[0], selected],
    ];
  }),
);

export const DatabaseModule: CapabilityModule<DatabaseSettings> = {
  name: "database",
  settings: DatabaseSettingsSchema,
  defaultSettings: defaults,
  defaultEnabled: true,
  defaultActivation: "eager",
  defaultVersion: databaseCatalog.defaultVersion,
  dependencies: [],
  releases: databaseReleases,
  routes: [{ listener: "database", protocol: "tcp" }],
  secretPolicy: () => "passthrough",
  managedSecretSlots: [],
};
