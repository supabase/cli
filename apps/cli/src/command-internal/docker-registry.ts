/**
 * Resolves a Docker image through the configured registry. `SUPABASE_INTERNAL_IMAGE_REGISTRY`
 * overrides the default ECR mirror; `docker.io` returns the image unchanged, and any other value
 * rewrites it to `<registry>/supabase/<last-path-segment>`. Callers that can retry pulls should
 * use {@link getRegistryImageUrlCandidates} instead, which falls back through GHCR and the
 * source image. Slim images (`ghcr.io/supabase/cli` / `public.ecr.aws/supabase/cli`) use a
 * host-prefix swap that keeps `@sha256` pins; env-hint reordering then fail-through.
 */
import { Config, ConfigProvider, Effect, Option } from "effect";

import { isSlimCatalogImage, slimImagePullCandidates } from "@supabase/stack/effect";

const INTERNAL_IMAGE_REGISTRY_ENV = "SUPABASE_INTERNAL_IMAGE_REGISTRY";
const DEFAULT_REGISTRY = "public.ecr.aws";
const DEFAULT_SUPABASE_REGISTRY = `${DEFAULT_REGISTRY}/supabase`;
const GHCR_REGISTRY = "ghcr.io";
const GHCR_SUPABASE_REGISTRY = `${GHCR_REGISTRY}/supabase`;
const DOCKER_HUB_REGISTRY = "docker.io";

function dedupe(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function getLastImageSegment(imageName: string): string {
  const parts = imageName.split("/");
  return parts[parts.length - 1] ?? imageName;
}

/**
 * `projectEnvValues` is optional: passing a project's dotenv-merged env lets a
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY` set only in `supabase/.env` (not the ambient shell) take
 * effect; omitting it keeps ambient-only behavior.
 */
const registryOverride = Effect.fnUntraced(function* (
  projectEnvValues?: Readonly<Record<string, string>>,
) {
  const ambient = yield* ConfigProvider.ConfigProvider;
  const provider =
    projectEnvValues === undefined
      ? ambient
      : ConfigProvider.orElse(
          ConfigProvider.fromEnvRecord(Object.fromEntries(Object.entries(projectEnvValues)), {
            preserveEmptyStrings: true,
          }),
          ambient,
        );
  return yield* Config.option(Config.string(INTERNAL_IMAGE_REGISTRY_ENV)).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, provider),
    Effect.map(Option.map((value) => value.trim().toLowerCase())),
  );
});

const mergedEnv = (
  projectEnvValues?: Readonly<Record<string, string>>,
): Readonly<Record<string, string | undefined>> =>
  projectEnvValues === undefined ? process.env : { ...process.env, ...projectEnvValues };

const overrideValue = (override: Option.Option<string>): string | undefined => {
  if (Option.isNone(override) || override.value.length === 0) return undefined;
  return override.value;
};

export function getRegistryImageUrl(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): Effect.Effect<string, Config.ConfigError> {
  if (isSlimCatalogImage(imageName)) {
    return registryOverride(projectEnvValues).pipe(
      Effect.map((override) => {
        const candidates = slimImagePullCandidates(imageName, {
          env: mergedEnv(projectEnvValues),
          ...(overrideValue(override) === undefined
            ? {}
            : { registryOverride: overrideValue(override) }),
        });
        return candidates[0] ?? imageName;
      }),
    );
  }
  return registryOverride(projectEnvValues).pipe(
    Effect.map((override) => rewriteRegistryImage(imageName, override)),
  );
}

export function getRegistryImageUrlCandidates(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): Effect.Effect<ReadonlyArray<string>, Config.ConfigError> {
  if (isSlimCatalogImage(imageName)) {
    return registryOverride(projectEnvValues).pipe(
      Effect.map((override) =>
        slimImagePullCandidates(imageName, {
          env: mergedEnv(projectEnvValues),
          ...(overrideValue(override) === undefined
            ? {}
            : { registryOverride: overrideValue(override) }),
        }),
      ),
    );
  }

  return registryOverride(projectEnvValues).pipe(
    Effect.map((override) => {
      const lastPart = getLastImageSegment(imageName);
      const image = rewriteRegistryImage(imageName, override);
      if (Option.isSome(override) && override.value.length > 0) {
        return [image];
      }
      return dedupe([
        image,
        `${GHCR_SUPABASE_REGISTRY}/${lastPart}`,
        dockerHubFallbackImage(imageName, lastPart),
      ]);
    }),
  );
}

function rewriteRegistryImage(imageName: string, override: Option.Option<string>): string {
  const registry = Option.getOrElse(
    override.pipe(Option.filter((value) => value.length > 0)),
    () => DEFAULT_REGISTRY,
  );
  return registry === DOCKER_HUB_REGISTRY
    ? imageName
    : `${registry}/supabase/${getLastImageSegment(imageName)}`;
}

function dockerHubFallbackImage(imageName: string, lastPart: string): string {
  if (
    imageName.startsWith(`${DEFAULT_SUPABASE_REGISTRY}/`) ||
    imageName.startsWith(`${GHCR_SUPABASE_REGISTRY}/`)
  ) {
    return `supabase/${lastPart}`;
  }
  return imageName;
}
