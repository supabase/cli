import {
  SERVICE_CATALOG,
  type ServiceCatalogEntry,
} from "../../command-internal/service-catalog.ts";

/**
 * Per-service orchestration metadata that `start.handler.ts` reads alongside `SERVICE_CATALOG`'s
 * identity fields (`containerSuffix`, `excludeKey`, `startOrder`). Descriptive only — the actual
 * config-boolean gating and image resolution live in the handler and each service's own module.
 */
export interface StartServiceMeta {
  /** Which `config.toml`-resolved image field feeds this service's container. */
  readonly imageConfigField: string;
  /**
   * The condition under which `start` brings up this service: a `config.toml` dotted-path
   * boolean expression, or a sentinel — `"always"` (Postgres) or `"none"` (gated only by
   * `!excluded`, e.g. Kong).
   */
  readonly enabledGate: string;
  /**
   * Other catalog `service` keys this service's startup depends on (e.g. Vector waits on
   * Logflare; Studio waits on pg-meta). Not a full dependency graph, just a sequencing hint.
   */
  readonly dependsOn?: ReadonlyArray<string>;
  /** The Kong route used to verify readiness when Docker cannot exec the health check. */
  readonly gatewayReadyPath?: string;
  /** The service is the gateway itself: any HTTP response from it proves it is up. */
  readonly gatewayReachable?: true;
}

export interface StartServiceEntry extends ServiceCatalogEntry, StartServiceMeta {}

/**
 * Per-service enabled-gate expression and image config field, keyed by
 * `SERVICE_CATALOG`'s `service` field.
 */
const START_SERVICE_META_BY_SERVICE: ReadonlyMap<string, StartServiceMeta> = new Map([
  ["postgres", { imageConfigField: "db.image", enabledGate: "always" }],
  [
    "logflare",
    {
      imageConfigField: "analytics.image",
      enabledGate: "analytics.enabled",
      gatewayReadyPath: "/analytics/v1/health",
    },
  ],
  [
    "vector",
    {
      imageConfigField: "analytics.vector_image",
      enabledGate: "analytics.enabled",
      dependsOn: ["logflare"],
    },
  ],
  ["kong", { imageConfigField: "api.kong_image", enabledGate: "none", gatewayReachable: true }],
  [
    "gotrue",
    {
      imageConfigField: "auth.image",
      enabledGate: "auth.enabled",
      gatewayReadyPath: "/auth/v1/health",
    },
  ],
  ["mailpit", { imageConfigField: "local_smtp.image", enabledGate: "local_smtp.enabled" }],
  ["realtime", { imageConfigField: "realtime.image", enabledGate: "realtime.enabled" }],
  ["postgrest", { imageConfigField: "api.image", enabledGate: "api.enabled" }],
  [
    "storage",
    {
      imageConfigField: "storage.image",
      enabledGate: "storage.enabled",
      gatewayReadyPath: "/storage/v1/status",
    },
  ],
  [
    "imgproxy",
    {
      imageConfigField: "storage.imgproxy_image",
      enabledGate: "storage.enabled && storage.image_transformation.enabled",
      dependsOn: ["storage"],
    },
  ],
  ["edgeRuntime", { imageConfigField: "edge_runtime.image", enabledGate: "edge_runtime.enabled" }],
  [
    "pgMeta",
    {
      imageConfigField: "studio.pgmeta_image",
      enabledGate: "studio.enabled",
      gatewayReadyPath: "/pg/health",
    },
  ],
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
export function startServiceMeta(service: string): StartServiceMeta | undefined {
  return START_SERVICE_META_BY_SERVICE.get(service);
}

/**
 * `SERVICE_CATALOG` augmented with this file's orchestration metadata, preserving the catalog's
 * `startOrder` so `start.handler.ts` can iterate it directly to bring services up in order.
 */
export const START_SERVICES: ReadonlyArray<StartServiceEntry> = SERVICE_CATALOG.map((entry) => {
  const meta = START_SERVICE_META_BY_SERVICE.get(entry.service);
  return {
    ...entry,
    imageConfigField: meta?.imageConfigField ?? "",
    enabledGate: meta?.enabledGate ?? "",
    dependsOn: meta?.dependsOn,
    gatewayReadyPath: meta?.gatewayReadyPath,
    gatewayReachable: meta?.gatewayReachable,
  };
});
