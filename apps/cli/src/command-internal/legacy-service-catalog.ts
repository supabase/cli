/**
 * Per-service identity catalog for the local dev stack — the single source of
 * truth `start` and `status` both read so they can never drift on container
 * name suffixes or `--exclude` keys.
 *
 * `containerSuffix` matches the suffix strings `legacyServiceContainerIds`/
 * `localDbContainerId` feed into `legacyServiceContainerName` (`legacy-docker-ids.ts`)
 * — cross-check by exact string, not by array position, since that function's
 * array order (Go's `utils.GetDockerIds()`, `apps/cli-go/internal/utils/config.go:82-98`)
 * differs from this catalog's order.
 *
 * `excludeKey` matches `utils.ShortContainerImageName(image)` for each of
 * `config.Images.Services()` (`apps/cli-go/pkg/config/constants.go:60-76`) — the
 * value Go's `--exclude` flag matches against. Go's own `ExcludableContainers()`
 * (formerly `apps/cli-go/internal/start/start.go:1297-1303`) was deleted along
 * with the rest of `internal/start` as unreachable (CLI-1966; last present at
 * commit a253ccba2) — the equivalent logic now lives inline in
 * `apps/cli-go/cmd/start.go`'s `excludableContainers()`. Postgres has no
 * `excludeKey` — it is never excludable in Go.
 *
 * Array order matches Go's actual container start sequence (formerly
 * `apps/cli-go/internal/start/start.go`'s "Start <service>" comments, lines
 * 293-1267, deleted in CLI-1966; last present at commit a253ccba2): Postgres,
 * then each service's `if` block in file order. `startOrder` (1-14) mirrors
 * that same order as an explicit field.
 */
export interface LegacyServiceCatalogEntry {
  /** Stable service key, independent of both the container suffix and the exclude key. */
  readonly service: string;
  /** Matches a `legacyServiceContainerIds`/`localDbContainerId` suffix string exactly. */
  readonly containerSuffix: string;
  /** `--exclude` key (`utils.ShortContainerImageName`). Absent for Postgres — never excludable. */
  readonly excludeKey?: string;
  /** 1-14, matching Go's real container start sequence in the now-deleted `internal/start/start.go` (CLI-1966; last present at commit a253ccba2). */
  readonly startOrder: number;
}

export const LEGACY_SERVICE_CATALOG: ReadonlyArray<LegacyServiceCatalogEntry> = [
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
