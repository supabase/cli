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
const DEFAULT_REGISTRY = "public.ecr.aws";
const GHCR_REGISTRY = "ghcr.io";

function legacyGetRegistryOverride(): string | undefined {
  const registry = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
  return registry === undefined || registry.length === 0 ? undefined : registry.toLowerCase();
}

function legacyGetRegistry(): string {
  return legacyGetRegistryOverride() ?? DEFAULT_REGISTRY;
}

export function legacyGetRegistryImageUrl(imageName: string): string {
  const registry = legacyGetRegistry();
  if (registry === "docker.io") {
    return imageName;
  }
  const parts = imageName.split("/");
  const lastPart = parts[parts.length - 1] ?? imageName;
  return `${registry}/supabase/${lastPart}`;
}

export function legacyGetRegistryImageUrlCandidates(imageName: string): ReadonlyArray<string> {
  if (legacyGetRegistryOverride() !== undefined) {
    return [legacyGetRegistryImageUrl(imageName)];
  }
  const parts = imageName.split("/");
  const lastPart = parts[parts.length - 1] ?? imageName;
  return dedupe([
    `${DEFAULT_REGISTRY}/supabase/${lastPart}`,
    `${GHCR_REGISTRY}/supabase/${lastPart}`,
    dockerHubFallbackImage(imageName, lastPart),
  ]);
}

function dedupe(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)];
}

function dockerHubFallbackImage(imageName: string, lastPart: string): string {
  if (
    imageName.startsWith(`${DEFAULT_REGISTRY}/supabase/`) ||
    imageName.startsWith(`${GHCR_REGISTRY}/supabase/`)
  ) {
    return `supabase/${lastPart}`;
  }
  return imageName;
}
