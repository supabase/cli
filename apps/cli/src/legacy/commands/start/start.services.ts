import {
  LEGACY_SERVICE_CATALOG,
  type LegacyServiceCatalogEntry,
} from "../../shared/legacy-service-catalog.ts";

/**
 * Per-service orchestration metadata `start.handler.ts` (a later task) reads
 * ON TOP OF `LEGACY_SERVICE_CATALOG`'s identity fields (`containerSuffix`,
 * `excludeKey`, `startOrder`). Deliberately descriptive, not executable: the
 * real config-boolean gating and image resolution live in the handler and
 * each service's own module.
 */
export interface LegacyStartServiceMeta {
  /**
   * Which `config.toml`-resolved image field feeds this service's container.
   * A string identifier only — actual resolution happens in the service's
   * own module.
   */
  readonly imageConfigField: string;
  /**
   * The condition under which Go starts this service, expressed as a
   * `config.toml` dotted-path boolean expression, or one of the sentinels
   * `"always"` (Postgres, unconditional) / `"none"` (gated only by
   * `!excluded`, e.g. Kong).
   */
  readonly enabledGate: string;
  /**
   * Other catalog `service` keys this service's startup additionally depends
   * on (e.g. Vector waits on Logflare being healthy; Studio waits on
   * pg-meta). Not a full dependency graph — just a note for the handler to
   * sequence against.
   */
  readonly dependsOn?: ReadonlyArray<string>;
}

export interface LegacyStartServiceEntry
  extends LegacyServiceCatalogEntry, LegacyStartServiceMeta {}

/**
 * Source: the approved start-port plan's per-service table, cross-referenced
 * against `apps/cli-go/internal/start/start.go`'s per-service `if` blocks
 * (lines 293-1267) and `pkg/config/config.go`'s image field resolution.
 * Keyed by `LEGACY_SERVICE_CATALOG`'s `service` field.
 */
const START_SERVICE_META_BY_SERVICE: ReadonlyMap<string, LegacyStartServiceMeta> = new Map([
  ["postgres", { imageConfigField: "db.image", enabledGate: "always" }],
  ["logflare", { imageConfigField: "analytics.image", enabledGate: "analytics.enabled" }],
  [
    "vector",
    {
      imageConfigField: "analytics.vector_image",
      enabledGate: "analytics.enabled",
      dependsOn: ["logflare"],
    },
  ],
  ["kong", { imageConfigField: "api.kong_image", enabledGate: "none" }],
  ["gotrue", { imageConfigField: "auth.image", enabledGate: "auth.enabled" }],
  ["mailpit", { imageConfigField: "local_smtp.image", enabledGate: "local_smtp.enabled" }],
  ["realtime", { imageConfigField: "realtime.image", enabledGate: "realtime.enabled" }],
  ["postgrest", { imageConfigField: "api.image", enabledGate: "api.enabled" }],
  ["storage", { imageConfigField: "storage.image", enabledGate: "storage.enabled" }],
  [
    "imgproxy",
    {
      imageConfigField: "storage.imgproxy_image",
      enabledGate: "storage.enabled && storage.image_transformation.enabled",
      dependsOn: ["storage"],
    },
  ],
  ["edgeRuntime", { imageConfigField: "edge_runtime.image", enabledGate: "edge_runtime.enabled" }],
  ["pgMeta", { imageConfigField: "studio.pgmeta_image", enabledGate: "studio.enabled" }],
  [
    "studio",
    {
      imageConfigField: "studio.image",
      enabledGate: "studio.enabled",
      dependsOn: ["pgMeta"],
    },
  ],
  ["supavisor", { imageConfigField: "db.pooler.image", enabledGate: "db.pooler.enabled" }],
]);

/** Looks up a single service's start orchestration metadata by its catalog `service` key. */
export function legacyStartServiceMeta(service: string): LegacyStartServiceMeta | undefined {
  return START_SERVICE_META_BY_SERVICE.get(service);
}

/**
 * `LEGACY_SERVICE_CATALOG`, augmented with this file's orchestration metadata.
 * Preserves the catalog's `startOrder` ordering — `start.handler.ts` can
 * iterate this array directly to bring services up in Go's real sequence.
 */
export const LEGACY_START_SERVICES: ReadonlyArray<LegacyStartServiceEntry> =
  LEGACY_SERVICE_CATALOG.map((entry) => {
    const meta = START_SERVICE_META_BY_SERVICE.get(entry.service);
    return {
      ...entry,
      imageConfigField: meta?.imageConfigField ?? "",
      enabledGate: meta?.enabledGate ?? "",
      dependsOn: meta?.dependsOn,
    };
  });
