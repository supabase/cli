import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../shared/services/slim-images.ts";
import { resolvePinnedImage } from "./pinned-image.ts";

const currentTag = (alias: string) => dockerfileServiceImageRaw(alias).split(":")[1] ?? "";
const currentAuth = dockerfileServiceImageRaw("gotrue");
const currentAuthTag = currentTag("gotrue");
const currentPooler = dockerfileServiceImageRaw("supavisor");
const currentPoolerTag = currentTag("supavisor");
const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = currentTag("pg");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePinnedImage", () => {
  it("resolves docker.io images while the slim flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
    expect(resolvePinnedImage("gotrue", "auth", {})).toBe(currentAuth);
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" })).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" })).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("resolves slim images when the flag is on and the pin is current", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(resolvePinnedImage("gotrue", "auth", {})).toBe(toSlimImage("gotrue", currentAuth));
    expect(resolvePinnedImage("gotrue", "auth", { auth: currentAuthTag })).toBe(
      toSlimImage("gotrue", currentAuth),
    );
  });

  it("keeps a historical pin on docker.io", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" })).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("storage", "storage", { storage: "v1.67.0" })).toBe(
      "supabase/storage-api:v1.67.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" })).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("normalizes a current pooler pin onto the slim tag scheme", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: currentPoolerTag })).toBe(
      toSlimImage("supavisor", currentPooler),
    );
    expect(
      resolvePinnedImage("supavisor", "pooler", {
        pooler: currentPoolerTag.startsWith("v")
          ? currentPoolerTag.slice(1)
          : `v${currentPoolerTag}`,
      }),
    ).toBe(toSlimImage("supavisor", currentPooler));
  });

  it("keeps a historical postgres pin on docker.io", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" })).toBe(
      "supabase/postgres:17.4.1.1",
    );
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" })).toBe(
      "supabase/postgres:17.4.1.1",
    );
    expect(resolvePinnedImage("pg", "postgres", { postgres: currentPostgresTag })).toBe(
      toSlimImage("pg", currentPostgres),
    );
  });
});
