import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerfileServiceImageRaw } from "./dockerfile-images.ts";
import { slimCatalogPin, toSlimImage } from "./slim-images.ts";

/**
 * Every slim-capable Dockerfile alias, against the real (unmocked) catalog. The Dockerfile is
 * generated from that same catalog (`render-service-dockerfile.ts`), so each alias's raw tag is
 * always one of the catalog's own upstream versions by construction — no fixture, no
 * `vi.mock`, exercising the true "one-time alignment" invariant end to end.
 */
const SLIM_CAPABLE_ALIASES = [
  "pg",
  "pg15",
  "gotrue",
  "postgrest",
  "realtime",
  "storage",
  "edgeruntime",
  "studio",
  "pgmeta",
  "logflare",
  "supavisor",
  "vector",
  "imgproxy",
  "mailpit",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slim mode against the real catalog", () => {
  it.each(SLIM_CAPABLE_ALIASES)("resolves the %s alias to its pinned catalog image", (alias) => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const raw = dockerfileServiceImageRaw(alias);
    const pin = slimCatalogPin(alias, raw);
    expect(pin).toBeDefined();
    const resolved = toSlimImage(alias, raw);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/^ghcr\.io\/supabase\/cli\//);
  });

  it("has no slim entry for aliases with no slim build", () => {
    for (const alias of ["kong", "pg14", "differ", "migra", "pgprove"]) {
      const raw = dockerfileServiceImageRaw(alias);
      expect(toSlimImage(alias, raw)).toBeUndefined();
    }
  });
});
