import type { CliConfig } from "@supabase/config";

import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import type {
  LocalServiceVersionName,
  LocalServiceVersionOverrides,
} from "../../shared/services/services.shared.ts";
import { resolvePinnedImage } from "../../command-internal/db-bootstrap/pinned-image.ts";
import { envOverrideBool } from "../../command-internal/local-config-values.ts";
import { START_SERVICES } from "./start.services.ts";

/**
 * Every per-service start gate except Postgres (always-on, handled by the caller) and Edge
 * Runtime (bypasses the generic bring-up path; `start.handler.ts` reads its `enabled` flag
 * directly instead of going through {@link resolveStartImagePlan}). Each boolean is
 * `<section>.enabled` AND-ed with "not excluded".
 *
 * `imgproxy` is also gated on `storage` being enabled and on
 * `storage.image_transformation.enabled` — the same boolean feeds
 * `StorageEnvInput.imageTransformationEnabled`, so callers must reuse `gates.imgproxy` rather than
 * recompute a second, possibly-diverging value.
 */
export interface StartGates {
  readonly kong: boolean;
  readonly gotrue: boolean;
  readonly mailpit: boolean;
  readonly realtime: boolean;
  readonly postgrest: boolean;
  readonly storage: boolean;
  readonly imgproxy: boolean;
  readonly logflare: boolean;
  readonly vector: boolean;
  readonly pgMeta: boolean;
  readonly studio: boolean;
  readonly supavisor: boolean;
  readonly edgeRuntime: boolean;
}

export interface StartGateInputs {
  readonly config: CliConfig;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /** `partitionStartExcludeFlags(flags.exclude).valid`, as a `Set` for O(1) lookup. */
  readonly excludedKeys: ReadonlySet<string>;
  readonly document: Readonly<Record<string, unknown>> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Evaluates every excludable start gate in one pass. Postgres and Edge Runtime are handled
 * separately by the caller (see this module's header).
 */
export function resolveStartGates(inputs: StartGateInputs): StartGates {
  const { config, projectEnvValues, excludedKeys, document } = inputs;
  const isExcluded = (key: string) => excludedKeys.has(key);

  const analyticsEnabled = envOverrideBool(
    "SUPABASE_ANALYTICS_ENABLED",
    config.analytics.enabled,
    "analytics.enabled",
    projectEnvValues,
  );
  const apiEnabled = envOverrideBool(
    "SUPABASE_API_ENABLED",
    config.api.enabled,
    "api.enabled",
    projectEnvValues,
  );
  const authEnabled = envOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const inbucketEnabled = envOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const realtimeEnabled = envOverrideBool(
    "SUPABASE_REALTIME_ENABLED",
    config.realtime.enabled,
    "realtime.enabled",
    projectEnvValues,
  );
  const storageEnabled = envOverrideBool(
    "SUPABASE_STORAGE_ENABLED",
    config.storage.enabled,
    "storage.enabled",
    projectEnvValues,
  );
  // The section must be present in the raw document before the env override can flip it on:
  // `@supabase/config` always decodes `storage.image_transformation` to a defaulted
  // `{enabled: false}`, never `undefined`, so presence can't be read off the typed config.
  const imageTransformationSectionPresent =
    asRecord(asRecord(document?.["storage"])?.["image_transformation"]) !== undefined;
  const configuredImageTransformationEnabled =
    config.storage.image_transformation?.enabled ?? false;
  const imageTransformationEnabled = imageTransformationSectionPresent
    ? envOverrideBool(
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
        configuredImageTransformationEnabled,
        "storage.image_transformation.enabled",
        projectEnvValues,
      )
    : configuredImageTransformationEnabled;
  const studioEnabled = envOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const poolerEnabled = envOverrideBool(
    "SUPABASE_DB_POOLER_ENABLED",
    config.db.pooler.enabled,
    "db.pooler.enabled",
    projectEnvValues,
  );
  const edgeRuntimeEnabled = envOverrideBool(
    "SUPABASE_EDGE_RUNTIME_ENABLED",
    config.edge_runtime.enabled,
    "edge_runtime.enabled",
    projectEnvValues,
  );

  const storage = storageEnabled && !isExcluded("storage-api");

  return {
    kong: !isExcluded("kong"),
    gotrue: authEnabled && !isExcluded("gotrue"),
    mailpit: inbucketEnabled && !isExcluded("mailpit"),
    realtime: realtimeEnabled && !isExcluded("realtime"),
    postgrest: apiEnabled && !isExcluded("postgrest"),
    storage,
    imgproxy: storage && imageTransformationEnabled && !isExcluded("imgproxy"),
    logflare: analyticsEnabled && !isExcluded("logflare"),
    vector: analyticsEnabled && !isExcluded("vector"),
    pgMeta: studioEnabled && !isExcluded("postgres-meta"),
    studio: studioEnabled && !isExcluded("studio"),
    supavisor: poolerEnabled && !isExcluded("supavisor"),
    edgeRuntime: edgeRuntimeEnabled && !isExcluded("edge-runtime"),
  };
}

const GATE_KEY_BY_SERVICE: Readonly<Record<string, keyof StartGates>> = {
  logflare: "logflare",
  vector: "vector",
  kong: "kong",
  gotrue: "gotrue",
  mailpit: "mailpit",
  realtime: "realtime",
  postgrest: "postgrest",
  storage: "storage",
  imgproxy: "imgproxy",
  pgMeta: "pgMeta",
  studio: "studio",
  supavisor: "supavisor",
};

/** `shared/services/dockerfile-images.ts`'s `alias` for each excludable service — see the Dockerfile manifest's `FROM ... AS <alias>` lines. */
const DOCKERFILE_ALIAS_BY_SERVICE: Readonly<Record<string, string>> = {
  logflare: "logflare",
  vector: "vector",
  kong: "kong",
  gotrue: "gotrue",
  mailpit: "mailpit",
  realtime: "realtime",
  postgrest: "postgrest",
  storage: "storage",
  imgproxy: "imgproxy",
  pgMeta: "pgmeta",
  studio: "studio",
  supavisor: "supavisor",
};

/**
 * `START_SERVICES`' `service` key -> `LocalServiceVersionName`, for services that have a
 * `supabase/.temp/*-version` linked-project pin. Kong and ImgProxy have no such pin, so they're
 * absent here.
 */
const START_SERVICE_TO_LOCAL_VERSION_NAME: Readonly<Record<string, LocalServiceVersionName>> = {
  gotrue: "auth",
  postgrest: "postgrest",
  realtime: "realtime",
  storage: "storage",
  studio: "studio",
  pgMeta: "pgmeta",
  logflare: "analytics",
  supavisor: "pooler",
};

export interface StartImagePlanEntry {
  /** `SERVICE_CATALOG`'s `service` key. */
  readonly service: string;
  /** The default (unregistry-resolved) image reference for this service. */
  readonly image: string;
}

/**
 * The ordered list of non-Postgres, non-EdgeRuntime services that will actually start this run,
 * each paired with its default image reference, in the real container-start order (the order the
 * caller should both pre-pull images in and create+start containers in).
 *
 * Gates `imgproxy`'s image on the same `gates.imgproxy` boolean the container-start gate uses,
 * rather than pre-pulling it whenever Storage alone is enabled — pre-pulling an image for a
 * container that will never be created has no user-visible benefit.
 */
export function resolveStartImagePlan(
  gates: StartGates,
  serviceVersions: LocalServiceVersionOverrides = {},
): ReadonlyArray<StartImagePlanEntry> {
  const plan: Array<StartImagePlanEntry> = [];
  for (const entry of START_SERVICES) {
    const gateKey = GATE_KEY_BY_SERVICE[entry.service];
    if (gateKey === undefined || !gates[gateKey]) continue;
    const alias = DOCKERFILE_ALIAS_BY_SERVICE[entry.service];
    if (alias === undefined) continue;
    const localServiceName = START_SERVICE_TO_LOCAL_VERSION_NAME[entry.service];
    const image =
      localServiceName === undefined
        ? dockerfileServiceImage(alias)
        : resolvePinnedImage(alias, localServiceName, serviceVersions);
    plan.push({ service: entry.service, image });
  }
  return plan;
}
