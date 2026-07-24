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

/**
 * `projectEnvValues` (dotenv-merged env, ambient-wins) is optional and
 * additive — every existing caller that omits it keeps today's ambient-only
 * behavior unchanged. Only callers that already have a project's dotenv
 * values in scope (currently `start`, via `legacyGetRegistryImageUrlCandidates`)
 * need to pass it so a `SUPABASE_INTERNAL_IMAGE_REGISTRY` set only in
 * `supabase/.env`/project-root dotenv (not the ambient shell) is honored,
 * matching Go's `Config.Load` loading dotenv files into the process env
 * (`loadNestedEnv`, `pkg/config/config.go:789,1220-1258`) before `GetRegistry()`
 * (`internal/utils/docker.go:221-227`) ever reads it.
 */
function legacyGetRegistryOverride(
  projectEnvValues?: Readonly<Record<string, string>>,
): string | undefined {
  const registry = (
    projectEnvValues?.[LEGACY_INTERNAL_IMAGE_REGISTRY_ENV] ??
    process.env[LEGACY_INTERNAL_IMAGE_REGISTRY_ENV]
  )?.trim();
  return registry === undefined || registry.length === 0 ? undefined : registry.toLowerCase();
}

function legacyGetRegistry(projectEnvValues?: Readonly<Record<string, string>>): string {
  return legacyGetRegistryOverride(projectEnvValues) ?? DEFAULT_REGISTRY;
}

export function legacyGetRegistryImageUrl(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): string {
  const registry = legacyGetRegistry(projectEnvValues);
  if (registry === DOCKER_HUB_REGISTRY) {
    return imageName;
  }
  return `${registry}/supabase/${getLastImageSegment(imageName)}`;
}

export function legacyGetRegistryImageUrlCandidates(
  imageName: string,
  projectEnvValues?: Readonly<Record<string, string>>,
): ReadonlyArray<string> {
  if (legacyGetRegistryOverride(projectEnvValues) !== undefined) {
    return [legacyGetRegistryImageUrl(imageName, projectEnvValues)];
  }

  const lastPart = getLastImageSegment(imageName);
  return dedupe([
    legacyGetRegistryImageUrl(imageName, projectEnvValues),
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
