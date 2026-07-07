/**
 * Micro profile: normative values from
 * docs/specs/2026-07-07-micro-supabase-stacks-design.md ("The micro.conf profile").
 */
export const MICRO_POSTGRES_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  // memory
  ["shared_buffers", "16MB"],
  ["work_mem", "4MB"],
  ["maintenance_work_mem", "32MB"],
  ["jit", "off"],
  ["huge_pages", "off"],
  ["max_connections", "40"],
  // background CPU
  ["autovacuum_naptime", "5min"],
  ["autovacuum_max_workers", "1"],
  ["bgwriter_lru_maxpages", "0"],
  ["wal_writer_delay", "10s"],
  ["checkpoint_timeout", "30min"],
  ["max_parallel_workers", "0"],
  ["max_parallel_workers_per_gather", "0"],
  ["max_worker_processes", "4"],
  ["track_io_timing", "off"],
  // durability (disposable profile)
  ["fsync", "off"],
  ["synchronous_commit", "off"],
  ["full_page_writes", "off"],
  // replication reservations
  ["wal_level", "logical"],
  ["max_wal_senders", "5"],
  ["max_replication_slots", "5"],
  ["max_slot_wal_keep_size", "256MB"],
  ["wal_keep_size", "0"],
];

export const buildMicroConf = (): string =>
  `${MICRO_POSTGRES_SETTINGS.map(([k, v]) => `${k} = '${v}'`).join("\n")}\n`;

/** Extensions that only work when named in shared_preload_libraries. */
export const PRELOAD_REQUIRED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pg_cron",
  "pg_net",
  "timescaledb",
  "pg_stat_statements",
  "auto_explain",
  "pgaudit",
  "plan_filter",
  "supautils",
  "pgsodium",
]);

export const buildPodConf = (preloadLibraries: ReadonlyArray<string>): string =>
  `shared_preload_libraries = '${preloadLibraries.join(",")}'\n`;
