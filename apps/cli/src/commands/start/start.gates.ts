import type { CliConfig } from "@supabase/config";

import { dockerfileServiceImage } from "../../shared/services/dockerfile-images.ts";
import type {
  LocalServiceVersionName,
  LocalServiceVersionOverrides,
} from "../../shared/services/services.shared.ts";
import { resolvePinnedImage } from "../../command-internal/db-bootstrap/pinned-image.ts";
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
  /** `partitionStartExcludeFlags(flags.exclude).valid`, as a `Set` for O(1) lookup. */
  readonly excludedKeys: ReadonlySet<string>;
}

/**
 * Evaluates every excludable start gate in one pass. Postgres and Edge Runtime are handled
 * separately by the caller (see this module's header).
 */
export function resolveStartGates(inputs: StartGateInputs): StartGates {
  const { config, excludedKeys } = inputs;
  const isExcluded = (key: string) => excludedKeys.has(key);

  const storage = config.storage.enabled && !isExcluded("storage-api");
  const imageTransformationEnabled = config.storage.image_transformation?.enabled ?? false;

  return {
    kong: !isExcluded("kong"),
    gotrue: config.auth.enabled && !isExcluded("gotrue"),
    mailpit: config.local_smtp.enabled && !isExcluded("mailpit"),
    realtime: config.realtime.enabled && !isExcluded("realtime"),
    postgrest: config.api.enabled && !isExcluded("postgrest"),
    storage,
    imgproxy: storage && imageTransformationEnabled && !isExcluded("imgproxy"),
    logflare: config.analytics.enabled && !isExcluded("logflare"),
    vector: config.analytics.enabled && !isExcluded("vector"),
    pgMeta: config.studio.enabled && !isExcluded("postgres-meta"),
    studio: config.studio.enabled && !isExcluded("studio"),
    supavisor: config.db.pooler.enabled && !isExcluded("supavisor"),
    edgeRuntime: config.edge_runtime.enabled && !isExcluded("edge-runtime"),
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
  slim: boolean,
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
        ? dockerfileServiceImage(alias, slim)
        : resolvePinnedImage(alias, localServiceName, serviceVersions, slim);
    plan.push({ service: entry.service, image });
  }
  return plan;
}
