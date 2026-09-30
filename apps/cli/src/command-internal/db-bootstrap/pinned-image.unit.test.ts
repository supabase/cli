import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogPins } from "@supabase/stack/internal/artifacts";

import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { slimCatalogPin } from "../../shared/services/slim-images.ts";
import { resolvePinnedImage } from "./pinned-image.ts";

const currentTag = (alias: string) => dockerfileServiceImageRaw(alias).split(":")[1] ?? "";
const currentAuth = dockerfileServiceImageRaw("gotrue");
const currentAuthTag = currentTag("gotrue");
const currentPooler = dockerfileServiceImageRaw("supavisor");
const currentPoolerTag = currentTag("supavisor");
const currentPostgres = dockerfileServiceImageRaw("pg");
const currentPostgresTag = currentTag("pg");

/**
 * The catalog's own pinned image for `alias`'s (docker.io) `image` — read straight from
 * `catalogPins()`, independent of `toSlimImage`, so a test asserting against this actually
 * exercises the catalog lookup instead of passing whether or not it resolves (design B: a
 * default Dockerfile tag always matches a catalog pin). Only reuses `slimCatalogPin` for alias
 * and tag normalization (`v`-prefixing), not the catalog image lookup itself.
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

const GHCR_SLIM_IMAGE_PATTERN = /^ghcr\.io\/supabase\/cli\/.+@sha256:[0-9a-f]{64}$/;

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
