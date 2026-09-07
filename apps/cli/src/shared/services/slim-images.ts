const SLIM_IMAGES_ENV = "SUPABASE_USE_SLIM_IMAGES";
const SLIM_IMAGE_PREFIX = "ghcr.io/supabase/cli/";

/**
 * Maps embedded-Dockerfile aliases onto the slim service catalog. Aliases with
 * no slim build (kong, the `differ`/`migra`/`pgprove` job images) are absent and
 * keep their docker.io reference.
 */
const SLIM_SERVICE_BY_ALIAS = {
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
} as const;

type SlimServiceName = (typeof SLIM_SERVICE_BY_ALIAS)[keyof typeof SLIM_SERVICE_BY_ALIAS];

// Keep string alias lookups ergonomic while deriving the service union from
// the single alias table above.
const SLIM_SERVICE_LOOKUP: Readonly<Record<string, SlimServiceName>> = SLIM_SERVICE_BY_ALIAS;

const V_PREFIXED_SERVICES: ReadonlySet<SlimServiceName> = new Set([
  "auth",
  "postgrest",
  "realtime",
  "storage",
  "edge-runtime",
  "imgproxy",
  "mailpit",
  "pgmeta",
  "analytics",
  "pooler",
]);

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
 * Catalog-normalized slim tag under `ghcr.io/supabase/cli/<service>`. The
 * published slim catalog uses a `v` prefix for application services while
 * postgres, studio, and vector retain their unprefixed tags.
 */
function slimTagForService(service: SlimServiceName, rawTag: string): string {
  const tag = rawTag.trim();
  if (V_PREFIXED_SERVICES.has(service)) {
    return tag.slice(0, 1).toLowerCase() === "v" ? `v${tag.slice(1)}` : `v${tag}`;
  }
  return tag;
}

function slimImageRef(service: SlimServiceName, rawTag: string): string {
  return `${SLIM_IMAGE_PREFIX}${service}:${slimTagForService(service, rawTag)}`;
}

/**
 * Rewrites a docker.io image reference to its `ghcr.io/supabase/cli` slim
 * equivalent, keeping the pin's version. This helper owns tag normalization
 * (`v`-prefixing, `tagPrefix`), so pins that differ only in prefix between the
 * two registries (`supavisor`, `logflare`) land on the right slim tag. Vector's
 * docker.io tags carry an `-alpine` variant suffix that the slim build does
 * not publish, so the strip is scoped to `vector` only — an `-alpine`-suffixed
 * pin on any other service is a real tag, not a variant marker.
 */
export function toSlimImage(alias: string, image: string): string {
  const service = SLIM_SERVICE_LOOKUP[alias];
  if (service === undefined) {
    return image;
  }

  const tagSeparator = image.lastIndexOf(":");
  if (tagSeparator === -1) {
    return image;
  }

  const rawTag = image.slice(tagSeparator + 1);
  const tag = alias === "vector" ? rawTag.replace(/-alpine$/, "") : rawTag;
  return slimImageRef(service, tag);
}

/** `toSlimImage` behind the feature flag; a no-op while the flag is off. */
export function slimImageForAlias(alias: string, image: string): string {
  return slimImagesEnabled() ? toSlimImage(alias, image) : image;
}

export function imageTag(image: string): string | undefined {
  const tagSeparator = image.lastIndexOf(":");
  return tagSeparator === -1 ? undefined : image.slice(tagSeparator + 1);
}

function replaceImageTag(image: string, tag: string): string {
  const tagSeparator = image.lastIndexOf(":");
  return tagSeparator === -1 ? image : `${image.slice(0, tagSeparator + 1)}${tag}`;
}

/**
 * True when `pin` catalog-normalizes to the same slim tag as `currentRawImage`.
 * Historical `.temp` pins that would become unpublished slim tags return false.
 */
export function pinMatchesCurrentImage(
  alias: string,
  pin: string,
  currentRawImage: string,
): boolean {
  const currentTag = imageTag(currentRawImage);
  if (currentTag === undefined) {
    return false;
  }
  const service = SLIM_SERVICE_LOOKUP[alias];
  if (service === undefined) {
    return pin.trim() === currentTag;
  }
  return slimTagForService(service, pin) === slimTagForService(service, currentTag);
}

/**
 * Apply an optional `.temp` pin to the docker.io Dockerfile ref, then
 * slim-translate only when the flag is on and the pin is absent or current.
 */
export function slimImageForCurrentPin(
  alias: string,
  currentRawImage: string,
  pin?: string,
): string {
  const trimmed = pin?.trim() ?? "";
  const tagged = trimmed.length > 0 ? replaceImageTag(currentRawImage, trimmed) : currentRawImage;
  if (!slimImagesEnabled()) {
    return tagged;
  }
  if (trimmed.length > 0 && !pinMatchesCurrentImage(alias, trimmed, currentRawImage)) {
    return tagged;
  }
  return toSlimImage(alias, tagged);
}

/** Slim images are published only under this prefix; single home for the check. */
export function isSlimImageRef(image: string): boolean {
  return image.startsWith(SLIM_IMAGE_PREFIX);
}

/**
 * True when the flag is on AND `image` is a slim ghcr ref. Spec builders and
 * one-shot jobs use this so a ghcr-shaped override with the flag off stays on
 * the docker.io contract.
 */
export function usesSlimImageRuntime(image: string): boolean {
  return slimImagesEnabled() && isSlimImageRef(image);
}
