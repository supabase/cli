/**
 * Per-service identity catalog for the local dev stack — the single source of truth `start`
 * and `status` share, so container name suffixes and `--exclude` keys never drift between them.
 *
 * `containerSuffix` matches a suffix string exactly (cross-check by string, not array
 * position). Postgres has no `excludeKey` (never excludable). `startOrder` (1-14) matches the
 * container start sequence.
 */
export interface ServiceCatalogEntry {
  /** Stable service key, independent of both the container suffix and the exclude key. */
  readonly service: string;
  /** Matches a `serviceContainerIds`/`localDbContainerId` suffix string exactly. */
  readonly containerSuffix: string;
  /** `--exclude` key. Absent for Postgres — never excludable. */
  readonly excludeKey?: string;
  /** 1-14, matching the container start sequence. */
  readonly startOrder: number;
}

export const SERVICE_CATALOG: ReadonlyArray<ServiceCatalogEntry> = [
  { service: "postgres", containerSuffix: "db", startOrder: 1 },
  { service: "logflare", containerSuffix: "analytics", excludeKey: "logflare", startOrder: 2 },
  { service: "vector", containerSuffix: "vector", excludeKey: "vector", startOrder: 3 },
  { service: "kong", containerSuffix: "kong", excludeKey: "kong", startOrder: 4 },
  { service: "gotrue", containerSuffix: "auth", excludeKey: "gotrue", startOrder: 5 },
  { service: "mailpit", containerSuffix: "inbucket", excludeKey: "mailpit", startOrder: 6 },
  { service: "realtime", containerSuffix: "realtime", excludeKey: "realtime", startOrder: 7 },
  { service: "postgrest", containerSuffix: "rest", excludeKey: "postgrest", startOrder: 8 },
  { service: "storage", containerSuffix: "storage", excludeKey: "storage-api", startOrder: 9 },
  { service: "imgproxy", containerSuffix: "imgproxy", excludeKey: "imgproxy", startOrder: 10 },
  {
    service: "edgeRuntime",
    containerSuffix: "edge_runtime",
    excludeKey: "edge-runtime",
    startOrder: 11,
  },
  { service: "pgMeta", containerSuffix: "pg_meta", excludeKey: "postgres-meta", startOrder: 12 },
  { service: "studio", containerSuffix: "studio", excludeKey: "studio", startOrder: 13 },
  { service: "supavisor", containerSuffix: "pooler", excludeKey: "supavisor", startOrder: 14 },
];
