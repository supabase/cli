import type { ProjectConfig } from "@supabase/config";

import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import {
  replaceImageTag,
  type LocalServiceVersionName,
  type LocalServiceVersionOverrides,
} from "../../../shared/services/services.shared.ts";
import { legacyEnvOverrideBool } from "../../shared/legacy-local-config-values.ts";
import { LEGACY_START_SERVICES } from "./start.services.ts";

/**
 * Pure port of every per-service `if` guard in Go's `run()`
 * (`apps/cli-go/internal/start/start.go:293-1268`), minus Postgres (`enabledGate:
 * "always"`, unconditional — handled directly by the caller, before any other
 * service). Each boolean is `<section>.enabled` (resolved through
 * {@link legacyEnvOverrideBool}, matching Go's generic Viper `SUPABASE_<SECTION>_
 * ENABLED` binding — the same mechanism `legacy-status-values.ts`'s
 * `legacyResolveStatusLocalState` already uses for its own overlapping subset of
 * these fields) AND-ed with "not excluded" (the service's `--exclude` key absent
 * from `excludedKeys`, per `legacyPartitionStartExcludeFlags`'s `valid` set).
 *
 * `storage-api`'s exclude key backs BOTH `storage` and (compounded further)
 * `imgproxy` — `imgproxy` is additionally gated on `storage` already being
 * enabled (ImgProxy mounts Storage's own volumes, `start.go:1060`) and on
 * `storage.image_transformation.enabled`, mirroring Go's shared `isImgProxyEnabled`
 * local (`start.go:302-303`) — the SAME boolean feeds both the actual container
 * gate here and `storage.service.ts`'s `LegacyStorageEnvInput.
 * imageTransformationEnabled` (`ENABLE_IMAGE_TRANSFORMATION`), so callers must
 * reuse `gates.imgproxy`, not recompute a second, possibly-diverging boolean.
 *
 * `edgeRuntime` is deliberately excluded from `GATE_KEY_BY_SERVICE`/
 * `DOCKERFILE_ALIAS_BY_SERVICE`/{@link legacyResolveStartImagePlan} below — Edge
 * Runtime doesn't go through the generic `LegacyStartContainerSpec` bring-up path
 * (`services/edge-runtime.service.ts`'s header explains why it doesn't map
 * cleanly), so `start.handler.ts` reads this boolean directly and calls
 * `legacyStartEdgeRuntimeContainer` itself, in Go's real container-start position
 * (between ImgProxy and pg-meta).
 */
export interface LegacyStartGates {
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

export interface LegacyStartGateInputs {
  readonly config: ProjectConfig;
  readonly projectEnvValues: Readonly<Record<string, string>> | undefined;
  /** `legacyPartitionStartExcludeFlags(flags.exclude).valid`, as a `Set` for O(1) lookup. */
  readonly excludedKeys: ReadonlySet<string>;
  readonly document: Readonly<Record<string, unknown>> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Evaluates all 12 excludable "should this container actually start" gates in
 * one pass (Postgres and Edge Runtime are handled separately by the caller —
 * see this module's header). Pure — no Effect, no I/O — so every gate
 * combination is unit-testable without a Docker mock.
 */
export function legacyResolveStartGates(inputs: LegacyStartGateInputs): LegacyStartGates {
  const { config, projectEnvValues, excludedKeys, document } = inputs;
  const isExcluded = (key: string) => excludedKeys.has(key);

  const analyticsEnabled = legacyEnvOverrideBool(
    "SUPABASE_ANALYTICS_ENABLED",
    config.analytics.enabled,
    "analytics.enabled",
    projectEnvValues,
  );
  const apiEnabled = legacyEnvOverrideBool(
    "SUPABASE_API_ENABLED",
    config.api.enabled,
    "api.enabled",
    projectEnvValues,
  );
  const authEnabled = legacyEnvOverrideBool(
    "SUPABASE_AUTH_ENABLED",
    config.auth.enabled,
    "auth.enabled",
    projectEnvValues,
  );
  const inbucketEnabled = legacyEnvOverrideBool(
    "SUPABASE_LOCAL_SMTP_ENABLED",
    config.local_smtp.enabled,
    "local_smtp.enabled",
    projectEnvValues,
  );
  const realtimeEnabled = legacyEnvOverrideBool(
    "SUPABASE_REALTIME_ENABLED",
    config.realtime.enabled,
    "realtime.enabled",
    projectEnvValues,
  );
  const storageEnabled = legacyEnvOverrideBool(
    "SUPABASE_STORAGE_ENABLED",
    config.storage.enabled,
    "storage.enabled",
    projectEnvValues,
  );
  // Go's `Storage.ImageTransformation` is a nil-unless-declared pointer
  // (`pkg/config/storage.go:16`) — with no `[storage.image_transformation]`
  // table in config.toml, that field never becomes a resolvable Viper key at
  // all, so `SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED` alone can never
  // flip it on (`start.go:302-303`'s `ImageTransformation != nil && .Enabled`
  // gate short-circuits on the nil check first). `@supabase/config`'s decoded
  // `config.storage.image_transformation` can't be used as a presence proxy
  // either — it always decodes to a defaulted `{enabled: false}`, never
  // `undefined` — so presence must come from the raw document, same
  // `asRecord(document?.[...])` gate `legacyResolveAuthEmailSmtp`/
  // `resolveGotruePasskeyWebauthn`/`legacyResolveAuthSms` already use for the
  // identical Go-pointer-section shape.
  const imageTransformationSectionPresent =
    asRecord(asRecord(document?.["storage"])?.["image_transformation"]) !== undefined;
  const configuredImageTransformationEnabled =
    config.storage.image_transformation?.enabled ?? false;
  const imageTransformationEnabled = imageTransformationSectionPresent
    ? legacyEnvOverrideBool(
        "SUPABASE_STORAGE_IMAGE_TRANSFORMATION_ENABLED",
        configuredImageTransformationEnabled,
        "storage.image_transformation.enabled",
        projectEnvValues,
      )
    : configuredImageTransformationEnabled;
  const studioEnabled = legacyEnvOverrideBool(
    "SUPABASE_STUDIO_ENABLED",
    config.studio.enabled,
    "studio.enabled",
    projectEnvValues,
  );
  const poolerEnabled = legacyEnvOverrideBool(
    "SUPABASE_DB_POOLER_ENABLED",
    config.db.pooler.enabled,
    "db.pooler.enabled",
    projectEnvValues,
  );
  const edgeRuntimeEnabled = legacyEnvOverrideBool(
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

const GATE_KEY_BY_SERVICE: Readonly<Record<string, keyof LegacyStartGates>> = {
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
 * `LEGACY_START_SERVICES`' `service` key -> `services.shared.ts`'s
 * `LocalServiceVersionName`, for the subset of start's services that have a
 * `supabase/.temp/*-version` linked-project pin (Go's `pkg/config/config.go:
 * 827-863`). Kong and ImgProxy have no such pin in Go and are deliberately
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

/**
 * The embedded Dockerfile default image for `alias`, with its tag replaced by
 * `serviceVersions`' pin for `localServiceName` when one is present — Go's
 * `Config.Load` rewriting `c.Auth.Image`/etc. from `supabase/.temp/*-version`
 * (`pkg/config/config.go:827-863`) before `start`/`db start` ever read them.
 * Exported so `start.handler.ts` can resolve the SAME pinned image for the
 * one-shot fresh-DB setup jobs (`realtime`/`storage`/`auth`), which Go runs
 * regardless of `--exclude` and therefore can't go through
 * {@link legacyResolveStartImagePlan}'s gate-filtered plan.
 */
export function legacyResolvePinnedImage(
  alias: string,
  localServiceName: LocalServiceVersionName,
  serviceVersions: LocalServiceVersionOverrides,
): string {
  const baseImage = dockerfileServiceImage(alias);
  const pinnedVersion = serviceVersions[localServiceName];
  return pinnedVersion === undefined ? baseImage : replaceImageTag(baseImage, pinnedVersion);
}

export interface LegacyStartImagePlanEntry {
  /** `LEGACY_SERVICE_CATALOG`'s `service` key. */
  readonly service: string;
  /** The default (unregistry-resolved) image reference for this service. */
  readonly image: string;
}

/**
 * The ordered list of non-Postgres, non-EdgeRuntime services that will
 * actually start this run, each paired with its default image reference —
 * Go's `ensureImagesCached`/ `pullImagesUsingCompose` input (`start.go:264-291`),
 * built from `utils.GetServices()`'s own per-section `.Enabled` gates
 * (`internal/utils/config.go:102-193`). Iterates `LEGACY_START_SERVICES` (already
 * in Go's real container-start order) so the returned order IS the order the
 * caller should both pre-pull images in and create+start containers in.
 *
 * Deliberately gates `imgproxy`'s image on the SAME compound `gates.imgproxy`
 * boolean the actual container-start gate uses, rather than Go's slightly
 * looser `Config.Storage.Enabled` pre-pull scope (`utils.GetServices`,
 * `config.go:143-153`, which pre-pulls the ImgProxy image whenever Storage is
 * enabled, even with image transformation disabled) — a deliberate, documented
 * simplification: pre-pulling an image for a container that will never be
 * created has no user-visible benefit and this port has no compose-based
 * best-effort pre-pull pass to mirror in the first place (see
 * `lib/image-prepull.ts`'s header).
 */
export function legacyResolveStartImagePlan(
  gates: LegacyStartGates,
  serviceVersions: LocalServiceVersionOverrides = {},
): ReadonlyArray<LegacyStartImagePlanEntry> {
  const plan: Array<LegacyStartImagePlanEntry> = [];
  for (const entry of LEGACY_START_SERVICES) {
    const gateKey = GATE_KEY_BY_SERVICE[entry.service];
    if (gateKey === undefined || !gates[gateKey]) continue;
    const alias = DOCKERFILE_ALIAS_BY_SERVICE[entry.service];
    if (alias === undefined) continue;
    const localServiceName = START_SERVICE_TO_LOCAL_VERSION_NAME[entry.service];
    const image =
      localServiceName === undefined
        ? dockerfileServiceImage(alias)
        : legacyResolvePinnedImage(alias, localServiceName, serviceVersions);
    plan.push({ service: entry.service, image });
  }
  return plan;
}
