import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { dockerfileServiceImageRaw } from "../services/dockerfile-images.ts";
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
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });

  it("rewrites the current Dockerfile tag onto the slim ghcr.io image when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage(currentEdgeRuntimeTag)).toBe(
      `ghcr.io/supabase/cli/edge-runtime:${currentEdgeRuntimeTag}`,
    );
  });

  it("keeps a historical pin on docker.io when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage("v1.73.0")).toBe("supabase/edge-runtime:v1.73.0");
  });

  it("keeps the deno1 tag on the docker.io image while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });
});

describe("resolveEdgeRuntimeVersionPin", () => {
  it("falls back to the Dockerfile tag, not the ghcr host, when slim is on and no pin file exists", async () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const tag = await Effect.runPromise(resolveEdgeRuntimeVersionPin("/no-such-supabase-dir"));
    expect(tag).toBe(currentEdgeRuntimeTag);
    expect(tag.includes("/")).toBe(false);
  });

  it("falls back to the Dockerfile tag while the flag is off", async () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    const tag = await Effect.runPromise(resolveEdgeRuntimeVersionPin("/no-such-supabase-dir"));
    expect(tag).toBe(currentEdgeRuntimeTag);
  });
});
