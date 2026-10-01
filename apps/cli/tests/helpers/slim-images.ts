import { catalogPins } from "@supabase/stack/internal/artifacts";

import { slimCatalogPin } from "../../src/shared/services/slim-images.ts";

/** A regression to the docker.io fallback must fail an assertion built from this. */
export const GHCR_SLIM_IMAGE_PATTERN = /^ghcr\.io\/supabase\/cli\/.+@sha256:[0-9a-f]{64}$/;

/** The catalog's pinned image for `alias`'s `image`, read independently of `toSlimImage`. */
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
