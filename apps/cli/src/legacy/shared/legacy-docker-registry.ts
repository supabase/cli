/**
 * Resolve a Docker image through the configured registry, a 1:1 port of Go's
 * `utils.GetRegistryImageUrl` / `GetRegistry` (`apps/cli-go/internal/utils/docker.go:185-203`).
 *
 * `SUPABASE_INTERNAL_IMAGE_REGISTRY` (Go's viper `INTERNAL_IMAGE_REGISTRY`)
 * overrides the registry; an unset value uses the default ECR mirror. A value of
 * `docker.io` returns the image unchanged (pull from Docker Hub); any other
 * registry rewrites the image to `<registry>/supabase/<last-path-segment>` so
 * restricted/rate-limited environments pull from their configured mirror instead
 * of Docker Hub.
 *
 * When no registry override is configured, callers that can retry pulls should
 * use `legacyGetRegistryImageUrlCandidates`: ECR stays the fast default, with
 * GHCR and the source image as fallbacks for transient registry throttling.
 */
const LEGACY_INTERNAL_IMAGE_REGISTRY_ENV = "SUPABASE_INTERNAL_IMAGE_REGISTRY";
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

function legacyGetRegistryOverride(): string | undefined {
  const registry = process.env[LEGACY_INTERNAL_IMAGE_REGISTRY_ENV]?.trim();
  return registry === undefined || registry.length === 0 ? undefined : registry.toLowerCase();
}

function legacyGetRegistry(): string {
  return legacyGetRegistryOverride() ?? DEFAULT_REGISTRY;
}

export function legacyGetRegistryImageUrl(imageName: string): string {
  const registry = legacyGetRegistry();
  if (registry === DOCKER_HUB_REGISTRY) {
    return imageName;
  }
  return `${registry}/supabase/${getLastImageSegment(imageName)}`;
}

export function legacyGetRegistryImageUrlCandidates(imageName: string): ReadonlyArray<string> {
  if (legacyGetRegistryOverride() !== undefined) {
    return [legacyGetRegistryImageUrl(imageName)];
  }

  const lastPart = getLastImageSegment(imageName);
  return dedupe([
    legacyGetRegistryImageUrl(imageName),
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
