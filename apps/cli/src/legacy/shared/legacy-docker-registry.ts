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
 */
const DEFAULT_REGISTRY = "public.ecr.aws";

function legacyGetRegistry(): string {
  const registry = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
  return registry === undefined || registry.length === 0
    ? DEFAULT_REGISTRY
    : registry.toLowerCase();
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
