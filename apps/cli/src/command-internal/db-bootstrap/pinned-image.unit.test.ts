import { describe, expect, it } from "vitest";

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

describe("resolvePinnedImage", () => {
  it("resolves docker.io images while the slim flag is off", () => {
    expect(resolvePinnedImage("gotrue", "auth", {}, false)).toBe(currentAuth);
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" }, false)).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" }, false)).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("resolves slim images when the flag is on and the pin is current", () => {
    const pinned = expectedPinnedImage("gotrue", currentAuth);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(resolvePinnedImage("gotrue", "auth", {}, true)).toBe(pinned);
    expect(resolvePinnedImage("gotrue", "auth", { auth: currentAuthTag }, true)).toBe(pinned);
  });

  it("keeps a historical pin on docker.io", () => {
    expect(resolvePinnedImage("gotrue", "auth", { auth: "v2.100.0" }, true)).toBe(
      "supabase/gotrue:v2.100.0",
    );
    expect(resolvePinnedImage("storage", "storage", { storage: "v1.67.0" }, true)).toBe(
      "supabase/storage-api:v1.67.0",
    );
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: "2.0.0" }, true)).toBe(
      "supabase/supavisor:2.0.0",
    );
  });

  it("normalizes a current pooler pin onto the slim tag scheme", () => {
    const pinned = expectedPinnedImage("supavisor", currentPooler);
    expect(pinned).toMatch(GHCR_SLIM_IMAGE_PATTERN);
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: currentPoolerTag }, true)).toBe(
      pinned,
    );
    // The opposite `v`-prefix variant of the same pin still counts as current
    // (`pinMatchesCurrentImage` normalizes both before comparing), so it resolves to the very same
    // catalog-pinned slim image.
    const altPoolerTag = currentPoolerTag.startsWith("v")
      ? currentPoolerTag.slice(1)
      : `v${currentPoolerTag}`;
    expect(resolvePinnedImage("supavisor", "pooler", { pooler: altPoolerTag }, true)).toBe(pinned);
  });

  it("keeps a historical postgres pin on docker.io", () => {
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" }, false)).toBe(
      "supabase/postgres:17.4.1.1",
    );
    expect(resolvePinnedImage("pg", "postgres", { postgres: "17.4.1.1" }, true)).toBe(
      "supabase/postgres:17.4.1.1",
    );
    expect(resolvePinnedImage("pg", "postgres", { postgres: currentPostgresTag }, true)).toBe(
      expectedPinnedImage("pg", currentPostgres),
    );
  });
});
