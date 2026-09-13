/**
 * Resolves a Docker image through the configured registry. `SUPABASE_INTERNAL_IMAGE_REGISTRY`
 * overrides the default ECR mirror; `docker.io` returns the image unchanged, and any other value
 * rewrites it to `<registry>/supabase/<last-path-segment>`. Callers that can retry pulls should
 * use {@link getRegistryImageUrlCandidates} instead, which falls back through GHCR and the
 * source image. Slim images ({@link isSlimImageRef}) skip every rewrite — there's no mirror to
 * redirect them to.
 */
import { isSlimImageRef } from "../shared/services/slim-images.ts";

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
function getRegistryOverride(
  projectEnvValues?: Readonly<Record<string, string>>,
): string | undefined {
  const registry = (
    projectEnvValues?.[INTERNAL_IMAGE_REGISTRY_ENV] ?? process.env[INTERNAL_IMAGE_REGISTRY_ENV]
  )?.trim();
  return registry === undefined || registry.length === 0 ? undefined : registry.toLowerCase();
}

function getRegistry(projectEnvValues?: Readonly<Record<string, string>>): string {
  return getRegistryOverride(projectEnvValues) ?? DEFAULT_REGISTRY;
}

export function getRegistryImageUrl(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): string {
  if (isSlimImageRef(imageName)) {
    return imageName;
  }
  const registry = getRegistry(projectEnvValues);
  if (registry === DOCKER_HUB_REGISTRY) {
    return imageName;
  }
  return `${registry}/supabase/${getLastImageSegment(imageName)}`;
}

export function getRegistryImageUrlCandidates(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  if (isSlimImageRef(imageName)) {
    return [imageName];
  }

  if (getRegistryOverride(projectEnvValues) !== undefined) {
    return [getRegistryImageUrl(imageName, projectEnvValues)];
  }

  const lastPart = getLastImageSegment(imageName);
  return dedupe([
    getRegistryImageUrl(imageName, projectEnvValues),
    `${GHCR_SUPABASE_REGISTRY}/${lastPart}`,
    dockerHubFallbackImage(imageName, lastPart),
  ]);
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
