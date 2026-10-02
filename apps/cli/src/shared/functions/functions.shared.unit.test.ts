import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
import {
  expectedPinnedImage,
  GHCR_SLIM_IMAGE_PATTERN,
} from "../../../tests/helpers/slim-images.ts";
import {
  DENO1_EDGE_RUNTIME_VERSION,
  edgeRuntimeImage,
  resolveEdgeRuntimeVersionPin,
} from "./functions.shared.ts";

const rawEdgeRuntimeImage = dockerfileServiceImageRaw("edgeruntime");
const currentEdgeRuntimeTag = rawEdgeRuntimeImage.slice(rawEdgeRuntimeImage.lastIndexOf(":") + 1);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("edgeRuntimeImage", () => {
  it("keeps the deno1 tag on the docker.io image even when the slim flag is on", () => {
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION, true)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });

  it("rewrites the current Dockerfile tag onto the catalog-pinned slim ghcr.io image when the flag is on", () => {
    const pinned = expectedPinnedImage("edgeruntime", rawEdgeRuntimeImage);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(edgeRuntimeImage(currentEdgeRuntimeTag, true)).toBe(pinned);
  });

  it("keeps a historical pin on docker.io when the flag is on", () => {
    expect(edgeRuntimeImage("v1.73.0", true)).toBe("supabase/edge-runtime:v1.73.0");
  });
});

describe("resolveEdgeRuntimeVersionPin", () => {
  it.effect(
    "falls back to the Dockerfile tag, not the ghcr host, when slim is on and no pin file exists",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
        const tag = yield* resolveEdgeRuntimeVersionPin("/no-such-supabase-dir");
        expect(tag).toBe(currentEdgeRuntimeTag);
        expect(tag.includes("/")).toBe(false);
      }).pipe(Effect.provide(BunServices.layer)),
  );
});
