import { catalogPins } from "@supabase/stack/internal/artifacts";

import { slimCatalogPin } from "./slim-images.ts";

/** A regression to the docker.io fallback must fail an assertion built from this. */
export const GHCR_SLIM_IMAGE_PATTERN = /^ghcr\.io\/supabase\/cli\/.+@sha256:[0-9a-f]{64}$/;

/**
 * The catalog's own pinned image for `alias`'s (docker.io) `image` — read straight from
 * `catalogPins()`, independent of `toSlimImage`, so a test asserting against this actually
 * exercises the catalog lookup instead of passing whether or not it resolves (design B: a
 * default Dockerfile tag always matches a catalog pin). Only reuses `slimCatalogPin` for alias
 * and tag normalization (`v`-prefixing), not the catalog image lookup itself. Throws when
 * nothing is pinned, so a caller never silently falls back to a weaker assertion.
 */
export function expectedPinnedImage(alias: string, image: string): string {
  const pin = slimCatalogPin(alias, image);
  if (pin === undefined) {
    throw new Error(`no slim catalog pin for ${alias} ${image}`);
  }
  const entry = catalogPins().find(
    (candidate) =>
      candidate.sourceService === pin.service && candidate.pin.upstreamVersion === pin.version,
  );
  if (entry === undefined) {
    throw new Error(`no catalog pin for ${pin.service} ${pin.version}`);
  }
  return entry.pin.image;
}
