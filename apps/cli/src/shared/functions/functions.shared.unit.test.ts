import { afterEach, describe, expect, it, vi } from "vitest";

import { DENO1_EDGE_RUNTIME_VERSION, edgeRuntimeImage } from "./functions.shared.ts";

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

  it("rewrites a non-deno1 tag onto the slim ghcr.io image when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(edgeRuntimeImage("v1.74.3")).toBe("ghcr.io/supabase/cli/edge-runtime:v1.74.3");
  });

  it("keeps the deno1 tag on the docker.io image while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(edgeRuntimeImage(DENO1_EDGE_RUNTIME_VERSION)).toBe(
      `supabase/edge-runtime:${DENO1_EDGE_RUNTIME_VERSION}`,
    );
  });
});
