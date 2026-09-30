import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import {
  expectedPinnedImage,
  GHCR_SLIM_IMAGE_PATTERN,
} from "../../../tests/helpers/slim-images.ts";
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
    const pinned = expectedPinnedImage("gotrue", currentAuth);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(resolvePinnedImage("gotrue", "auth", {})).toBe(pinned);
    expect(resolvePinnedImage("gotrue", "auth", { auth: currentAuthTag })).toBe(pinned);
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
    const pinned = expectedPinnedImage("supavisor", currentPooler);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: currentPoolerTag })).toBe(pinned);
    // The opposite `v`-prefix variant of the same pin still counts as current
    // (`pinMatchesCurrentImage` normalizes both before comparing), so it resolves to the very same
    // catalog-pinned slim image.
    const altPoolerTag = currentPoolerTag.startsWith("v")
      ? currentPoolerTag.slice(1)
      : `v${currentPoolerTag}`;
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: altPoolerTag })).toBe(pinned);
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
      expectedPinnedImage("pg", currentPostgres),
    );
  });
});
