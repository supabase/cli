import { Effect, Schema } from "effect";
import { secret } from "./lib/env.ts";
import { stringEnum } from "./lib/schema.ts";

const links = {
  postgres: {
    name: "PostgreSQL configuration",
    link: "https://postgrest.org/en/stable/configuration.html",
  },
  pgbouncer: (id?: string) => ({
    name: "PgBouncer Configuration",
    link: `https://www.pgbouncer.org/config.html${id ? `#${id}` : ""}`,
  }),
};

const tags = ["database"];
const defaultDb = {};
const defaultPort = 54322;
const defaultShadowPort = 54320;
const defaultHealthTimeout = "2m";
const defaultMajorVersion = 17;
const defaultPooler = {};
const defaultPoolerEnabled = false;
const defaultPoolerPort = 54329;
const defaultPoolMode = "transaction";
const defaultPoolSize = 20;
const defaultMaxClientConn = 100;
const defaultMigrations = {};
const defaultMigrationsEnabled = true;
const defaultSchemaPaths: string[] = [];
const defaultSeed = {};
const defaultSeedEnabled = true;
const defaultSqlPaths = ["./seed.sql"];
const defaultNetworkRestrictions = {};
const defaultNetworkRestrictionsEnabled = false;
const defaultAllowedCidrs = ["0.0.0.0/0"];
const defaultAllowedCidrsV6 = ["::/0"];

const settings = Schema.Struct({
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(Schema.Number),
  max_locks_per_transaction: Schema.optionalKey(Schema.Number),
  max_parallel_maintenance_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers: Schema.optionalKey(Schema.Number),
  max_parallel_workers_per_gather: Schema.optionalKey(Schema.Number),
  max_replication_slots: Schema.optionalKey(Schema.Number),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Number),
  max_worker_processes: Schema.optionalKey(Schema.Number),
  session_replication_role: Schema.optionalKey(
    stringEnum(["origin", "replica", "local"], {
      description: "Session replication role.",
      tags,
    }),
  ),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(Schema.String),
  work_mem: Schema.optionalKey(Schema.String),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({})));

export const db = Schema.Struct({
  port: Schema.Number.annotate({
    default: defaultPort,
    description: "Port to use for the local database URL.",
    tags,
    links: [links.postgres],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPort))),
  shadow_port: Schema.Number.annotate({
    default: defaultShadowPort,
    description: "Port used by db diff command to initialize the shadow database.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultShadowPort))),
  health_timeout: Schema.String.annotate({
    default: defaultHealthTimeout,
    description:
      "Maximum amount of time to wait for health check when starting the local database.",
    tags,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultHealthTimeout))),
  major_version: Schema.Number.annotate({
    default: defaultMajorVersion,
    description:
      "The database major version to use. This has to be the same as your remote database's.",
    tags,
    links: [links.postgres],
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMajorVersion))),
  pooler: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultPoolerEnabled,
      description: "Enable the local PgBouncer service.",
      tags,
      links: [links.pgbouncer()],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPoolerEnabled))),
    port: Schema.Number.annotate({
      default: defaultPoolerPort,
      description: "Port to use for the local connection pooler.",
      tags,
      links: [links.pgbouncer("listen_port")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPoolerPort))),
    pool_mode: stringEnum(["transaction", "session"], {
      default: defaultPoolMode,
      description: "Specifies when a server connection can be reused by other clients.",
      tags,
      links: [links.pgbouncer("pool_mode")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPoolMode))),
    default_pool_size: Schema.Number.annotate({
      default: defaultPoolSize,
      description: "How many server connections to allow per user/database pair.",
      tags,
      links: [links.pgbouncer("default_pool_size")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultPoolSize))),
    max_client_conn: Schema.Number.annotate({
      default: defaultMaxClientConn,
      description: "Maximum number of client connections allowed.",
      tags,
      links: [links.pgbouncer("max_client_conn")],
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMaxClientConn))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultPooler }))),
  migrations: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultMigrationsEnabled,
      description: "If disabled, migrations will be skipped during a db push or reset.",
      tags,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultMigrationsEnabled))),
    schema_paths: Schema.Array(
      Schema.String.annotate({
        description: "Schema file path or glob relative to the supabase directory.",
        tags,
      }),
    )
      .annotate({
        default: defaultSchemaPaths,
        description: "Ordered list of schema files that describe your database.",
        tags,
      })
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultSchemaPaths]))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultMigrations }))),
  seed: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultSeedEnabled,
      description: "Enable seeding the database with SQL files.",
      tags,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultSeedEnabled))),
    sql_paths: Schema.Array(
      Schema.String.annotate({
        description: "Path to a SQL file used to seed the database.",
        tags,
      }),
    )
      .annotate({
        default: defaultSqlPaths,
        description: "Ordered list of seed files to load during db reset.",
        tags,
      })
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultSqlPaths]))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultSeed }))),
  settings: Schema.optionalKey(settings),
  network_restrictions: Schema.Struct({
    enabled: Schema.Boolean.annotate({
      default: defaultNetworkRestrictionsEnabled,
      description: "Enable management of network restrictions.",
      tags,
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultNetworkRestrictionsEnabled))),
    allowed_cidrs: Schema.Array(Schema.String)
      .annotate({
        default: defaultAllowedCidrs,
        description: "Allowed IPv4 CIDR blocks.",
        tags,
      })
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultAllowedCidrs]))),
    allowed_cidrs_v6: Schema.Array(Schema.String)
      .annotate({
        default: defaultAllowedCidrsV6,
        description: "Allowed IPv6 CIDR blocks.",
        tags,
      })
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed([...defaultAllowedCidrsV6]))),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultNetworkRestrictions }))),
  ssl_enforcement: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Boolean.annotate({
        default: false,
        description: "Reject non-secure connections to the database.",
        tags,
      }).pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  ),
  vault: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      secret({
        description: "Vault secret value.",
        tags,
      }),
    ).annotate({
      description: "Vault secrets.",
      tags,
    }),
  ),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultDb })));
