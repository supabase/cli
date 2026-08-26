import { dockerImageForService, type ServiceName } from "@supabase/stack/versions";

const SLIM_IMAGES_ENV = "SUPABASE_USE_SLIM_IMAGES";
const SLIM_IMAGE_PREFIX = "ghcr.io/supabase/cli/";

/**
 * Maps embedded-Dockerfile aliases onto the slim service catalog. Aliases with
 * no slim build (kong, the `differ`/`migra`/`pgprove` job images) are absent and
 * keep their docker.io reference.
 */
const SLIM_SERVICE_BY_ALIAS: Readonly<Record<string, ServiceName>> = {
  pg: "postgres",
  gotrue: "auth",
  postgrest: "postgrest",
  realtime: "realtime",
  storage: "storage",
  edgeruntime: "edge-runtime",
  studio: "studio",
  pgmeta: "pgmeta",
  logflare: "analytics",
  supavisor: "pooler",
  vector: "vector",
  imgproxy: "imgproxy",
  mailpit: "mailpit",
};

/**
 * Ambient process env only — the project-dotenv installers
 * (`legacy-db-config.toml-read.ts`, `legacy-local-project-context.ts`) copy
 * only a fixed set of keys into `process.env`, not arbitrary flags, so a
 * value set only in `supabase/.env` is not observed here. Read per call
 * rather than cached so tests can stub the ambient env per case.
 */
export function slimImagesEnabled(): boolean {
  const value = process.env[SLIM_IMAGES_ENV];
  return value === "true" || value === "1";
}

/**
 * Rewrites a docker.io image reference to its `ghcr.io/supabase/cli` slim
 * equivalent, keeping the Dockerfile's pinned version. The catalog owns tag
 * normalization (`v`-prefixing, `tagPrefix`), so pins that differ only in
 * prefix between the two registries (`supavisor`, `logflare`) land on the right
 * slim tag. Vector's docker.io tags carry an `-alpine` variant suffix that the
 * slim build does not publish, so the strip is scoped to `vector` only — an
 * `-alpine`-suffixed pin on any other service is a real tag, not a variant marker.
 */
export function toSlimImage(alias: string, image: string): string {
  const service = SLIM_SERVICE_BY_ALIAS[alias];
  if (service === undefined) {
    return image;
  }

  const tagSeparator = image.lastIndexOf(":");
  if (tagSeparator === -1) {
    return image;
  }

  const rawTag = image.slice(tagSeparator + 1);
  const tag = alias === "vector" ? rawTag.replace(/-alpine$/, "") : rawTag;
  return dockerImageForService(service, tag);
}

/** `toSlimImage` behind the feature flag; a no-op while the flag is off. */
export function slimImageForAlias(alias: string, image: string): string {
  return slimImagesEnabled() ? toSlimImage(alias, image) : image;
}

/** Slim images are published only under this prefix; single home for the check. */
export function isSlimImageRef(image: string): boolean {
  return image.startsWith(SLIM_IMAGE_PREFIX);
}

/**
 * True when the flag is on AND `image` is a slim ghcr ref. Spec builders and
 * one-shot jobs use this so a ghcr-shaped override with the flag off stays on
 * the docker.io contract (same gate as {@link legacyIsSlimPostgresImage}).
 */
export function usesSlimImageRuntime(image: string): boolean {
  return slimImagesEnabled() && isSlimImageRef(image);
}
