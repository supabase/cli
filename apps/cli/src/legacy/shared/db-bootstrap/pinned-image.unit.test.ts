import { afterEach, describe, expect, it, vi } from "vitest";

import { legacyResolvePinnedImage } from "./pinned-image.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("legacyResolvePinnedImage", () => {
  it("resolves docker.io images while the slim flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(legacyResolvePinnedImage("gotrue", "auth", {})).toBe("supabase/gotrue:v2.196.0");
    expect(legacyResolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" })).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(legacyResolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" })).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("resolves slim images when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(legacyResolvePinnedImage("gotrue", "auth", {})).toBe(
      "ghcr.io/supabase/cli/auth:v2.196.0",
    );
    expect(legacyResolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" })).toBe(
      "ghcr.io/supabase/cli/auth:v2.100.0",
    );
  });

  // A pin written to `supabase/.temp/<service>-version` follows docker.io's tag
  // scheme, which is unprefixed for these two while their slim tags are not.
  it("normalizes pooler and analytics pins onto the slim tag scheme", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(legacyResolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" })).toBe(
      "ghcr.io/supabase/cli/pooler:v2.0.0",
    );
    expect(legacyResolvePinnedImage("logflare", "analytics", { analytics: "1.4.0" })).toBe(
      "ghcr.io/supabase/cli/analytics:v1.4.0",
    );
  });

  it("keeps the postgres pin path stable across the flag", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(legacyResolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" })).toBe(
      "supabase/postgres:17.4.1.1",
    );
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    expect(legacyResolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" })).toBe(
      "ghcr.io/supabase/cli/postgres:17.4.1.1",
    );
  });
});
