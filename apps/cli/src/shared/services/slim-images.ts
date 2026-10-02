import { catalogPins } from "@supabase/stack/internal/artifacts";
import { Config, ConfigProvider, Effect, Option } from "effect";

const SLIM_IMAGES_ENV = "SUPABASE_USE_SLIM_IMAGES";
const SLIM_IMAGE_PREFIX = "ghcr.io/supabase/cli/";

/** Dockerfile alias to slim service; kong, `pg14`, and the job images have no slim build. */
const SLIM_SERVICE_BY_ALIAS = {
  pg: "postgres",
  pg15: "postgres",
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

/** The slim-image flag from the process environment, never the active `ConfigProvider`. */
export const slimImagesEnabled = Effect.suspend(() =>
  Config.option(Config.string(SLIM_IMAGES_ENV)).parse(ConfigProvider.fromEnv()),
).pipe(Effect.map(Option.exists((value) => value === "true" || value === "1")), Effect.orDie);

/** Catalog tag: `v`-prefixed for application services; postgres, studio, and vector stay bare. */
function slimTagForService(service: SlimServiceName, rawTag: string): string {
  const tag = rawTag.trim();
  if (V_PREFIXED_SERVICES.has(service)) {
    return tag.slice(0, 1).toLowerCase() === "v" ? `v${tag.slice(1)}` : `v${tag}`;
  }
  return tag;
}

export interface SlimCatalogPin {
  readonly service: SlimServiceName;
  readonly version: string;
}

/** OrioleDB tags are docker.io-only; slim-services does not publish them. */
function isOrioleImage(image: string): boolean {
  const tag = imageTag(image);
  return tag !== undefined && tag.toLowerCase().includes("orioledb");
}

/**
 * Slim service and tag for a Dockerfile alias. Absent when that alias has no
 * slim build (kong, the one-shot job images, and OrioleDB tags).
 */
export function slimCatalogPin(alias: string, image: string): SlimCatalogPin | undefined {
  if (isOrioleImage(image)) {
    return undefined;
  }
  const service = SLIM_SERVICE_LOOKUP[alias];
  if (service === undefined) {
    return undefined;
  }

  const rawTag = imageTag(image);
  if (rawTag === undefined) {
    return undefined;
  }

  const tag = alias === "vector" ? rawTag.replace(/-alpine$/, "") : rawTag;
  return { service, version: slimTagForService(service, tag) };
}

/** Keyed by the slim-services `sourceService`, which matches `SlimServiceName`. */
function catalogImageFor(service: SlimServiceName, upstreamVersion: string): string | undefined {
  for (const entry of catalogPins()) {
    if (entry.sourceService === service && entry.pin.upstreamVersion === upstreamVersion) {
      return entry.pin.image;
    }
  }
  return undefined;
}

/**
 * Resolves the catalog's pinned slim image matching `alias`'s normalized tag (via
 * {@link slimCatalogPin}), or `undefined` when no catalog pin matches — callers then keep the
 * upstream image instead of guessing a slim tag.
 */
export function toSlimImage(alias: string, image: string): string | undefined {
  const pin = slimCatalogPin(alias, image);
  if (pin === undefined) {
    return undefined;
  }
  return catalogImageFor(pin.service, pin.version);
}

/** `toSlimImage` behind the feature flag; a no-op while the flag is off. */
export function slimImageForAlias(alias: string, image: string, enabled: boolean): string {
  return enabled ? (toSlimImage(alias, image) ?? image) : image;
}

/** The tag portion of `image`, ignoring any `@sha256:…` digest suffix. */
export function imageTag(image: string): string | undefined {
  const withoutDigest = image.split("@")[0] ?? image;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  return tagSeparator === -1 ? undefined : withoutDigest.slice(tagSeparator + 1);
}

/** The repository portion of `image` (before the tag), the other half of `imageTag`'s split. */
export function imageRepository(image: string): string | undefined {
  const withoutDigest = image.split("@")[0] ?? image;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  return tagSeparator === -1 ? undefined : withoutDigest.slice(0, tagSeparator);
}

/** The `@sha256:…` digest suffix of `image`, if it carries one. */
export function imageDigest(image: string): string | undefined {
  const at = image.indexOf("@");
  return at === -1 ? undefined : image.slice(at + 1);
}

/** Replaces `image`'s tag with `tag`, dropping any `@sha256:…` digest — a new tag invalidates it. */
export function replaceImageTag(image: string, tag: string): string {
  const withoutDigest = image.split("@")[0] ?? image;
  const tagSeparator = withoutDigest.lastIndexOf(":");
  return tagSeparator === -1 ? image : `${withoutDigest.slice(0, tagSeparator + 1)}${tag}`;
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
  pin: string | undefined,
  enabled: boolean,
): string {
  const trimmed = pin?.trim() ?? "";
  const tagged = trimmed.length > 0 ? replaceImageTag(currentRawImage, trimmed) : currentRawImage;
  if (!enabled) {
    return tagged;
  }
  if (trimmed.length > 0 && !pinMatchesCurrentImage(alias, trimmed, currentRawImage)) {
    return tagged;
  }
  return toSlimImage(alias, tagged) ?? tagged;
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
export function usesSlimImageRuntime(image: string, enabled: boolean): boolean {
  return enabled && isSlimImageRef(image);
}
