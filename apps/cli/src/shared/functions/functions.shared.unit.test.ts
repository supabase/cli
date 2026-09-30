import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { catalogPins } from "@supabase/stack/internal/artifacts";

import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
import { slimCatalogPin } from "../services/slim-images.ts";
import {
  DENO1_EDGE_RUNTIME_VERSION,
  edgeRuntimeImage,
  resolveEdgeRuntimeVersionPin,
} from "./functions.shared.ts";

const rawEdgeRuntimeImage = dockerfileServiceImageRaw("edgeruntime");
const currentEdgeRuntimeTag = rawEdgeRuntimeImage.slice(rawEdgeRuntimeImage.lastIndexOf(":") + 1);

/**
 * The catalog's own pinned image for `alias`'s (docker.io) `image` — read straight from
 * `catalogPins()`, independent of `toSlimImage`, so a test asserting against this actually
 * exercises the catalog lookup instead of passing whether or not it resolves (design B: a
 * default Dockerfile tag always matches a catalog pin). Only reuses `slimCatalogPin` for alias
 * and tag normalization, not the catalog image lookup itself.
 */
function expectedPinnedImage(alias: string, image: string): string {
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("edgeRuntimeImage", () => {
  it("keeps the deno1 tag on the docker.io image even when the slim flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });

  it("rewrites the current Dockerfile tag onto the catalog-pinned slim ghcr.io image when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const pinned = expectedPinnedImage("edgeruntime", rawEdgeRuntimeImage);
    expect(pinned).toMatch(/^ghcr\.io\/supabase\/cli\/.+@sha256:[0-9a-f]{64}$/);
    expect(edgeRuntimeImage(currentEdgeRuntimeTag)).toBe(pinned);
  });

  it("keeps a historical pin on docker.io when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage("v1.73.0")).toBe("supabase/edge-runtime:v1.73.0");
  });
});

describe("resolveEdgeRuntimeVersionPin", () => {
  it("falls back to the Dockerfile tag, not the ghcr host, when slim is on and no pin file exists", async () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const tag = await Effect.runPromise(resolveEdgeRuntimeVersionPin("/no-such-supabase-dir"));
    expect(tag).toBe(currentEdgeRuntimeTag);
    expect(tag.includes("/")).toBe(false);
  });
});
