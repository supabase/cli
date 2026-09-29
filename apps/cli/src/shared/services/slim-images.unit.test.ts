import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerfileServiceImageRaw } from "./dockerfile-images.ts";
import {
  imageTag,
  pinMatchesCurrentImage,
  slimCatalogPin,
  slimImageForAlias,
  slimImageForCurrentPin,
  slimImagesEnabled,
  toSlimImage,
  usesSlimImageRuntime,
} from "./slim-images.ts";

// Only `auth` is pinned in this fixture catalog, at `v2.197.0-r0`, with a realistic
// (non-placeholder) fixture digest built to the real `ArtifactPin`/`NativePin` shape from
// `@supabase/stack/internal/artifacts`. Every other service is deliberately absent, so
// `toSlimImage` falls through to the upstream image for them — the expected state until
// Dependabot catches the Dockerfile up. `vi.mock` factories are hoisted above every other
// top-level statement, so the fixture is inlined rather than referencing an outer const.
vi.mock("@supabase/stack/internal/artifacts", () => {
  const digest = "d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c";
  const nativePin = { archive: digest, manifest: digest };
  return {
    catalogPins: () => [
      {
        service: "auth",
        sourceService: "auth",
        pin: {
          upstreamVersion: "v2.197.0",
          revision: 0,
          image: `ghcr.io/supabase/cli/auth:v2.197.0-r0@sha256:${digest}`,
          natives: {
            "darwin-arm64": nativePin,
            "linux-amd64": nativePin,
            "linux-arm64": nativePin,
          },
        },
      },
    ],
  };
});

const AUTH_FIXTURE_PIN_IMAGE =
  "ghcr.io/supabase/cli/auth:v2.197.0-r0@sha256:d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slimCatalogPin", () => {
  it.each([
    ["pg", "postgres"],
    ["gotrue", "auth"],
    ["postgrest", "postgrest"],
    ["realtime", "realtime"],
    ["storage", "storage"],
    ["edgeruntime", "edge-runtime"],
    ["studio", "studio"],
    ["pgmeta", "pgmeta"],
    ["logflare", "analytics"],
    ["supavisor", "pooler"],
    ["vector", "vector"],
    ["imgproxy", "imgproxy"],
    ["mailpit", "mailpit"],
  ])("maps the %s alias onto the %s slim service", (alias, service) => {
    const pin = slimCatalogPin(alias, dockerfileServiceImageRaw(alias));
    expect(pin?.service).toBe(service);
  });

  it("keeps a non-current pin's version verbatim", () => {
    expect(slimCatalogPin("pg", "supabase/postgres:17.6.1.164")).toEqual({
      service: "postgres",
      version: "17.6.1.164",
    });
    expect(slimCatalogPin("studio", "supabase/studio:2026.08.17-sha-0c1da8f")).toEqual({
      service: "studio",
      version: "2026.08.17-sha-0c1da8f",
    });
  });

  it("keeps a single v on pins already prefixed on docker.io", () => {
    expect(slimCatalogPin("realtime", "supabase/realtime:v2.130.0")).toEqual({
      service: "realtime",
      version: "v2.130.0",
    });
    expect(slimCatalogPin("storage", "supabase/storage-api:v1.72.1")).toEqual({
      service: "storage",
      version: "v1.72.1",
    });
    expect(slimCatalogPin("gotrue", "supabase/gotrue:V2.196.0")).toEqual({
      service: "auth",
      version: "v2.196.0",
    });
  });

  it("v-prefixes pins whose slim tag scheme differs from docker.io's", () => {
    expect(slimCatalogPin("supavisor", "supabase/supavisor:2.9.10")).toEqual({
      service: "pooler",
      version: "v2.9.10",
    });
    expect(slimCatalogPin("logflare", "supabase/logflare:1.50.4")).toEqual({
      service: "analytics",
      version: "v1.50.4",
    });
    expect(slimCatalogPin("pgmeta", "supabase/postgres-meta:v0.98.0")).toEqual({
      service: "pgmeta",
      version: "v0.98.0",
    });
  });

  it("excludes OrioleDB tags", () => {
    expect(slimCatalogPin("pg", "supabase/postgres:16.0.0.1-orioledb")).toBeUndefined();
    expect(slimCatalogPin("pg", "supabase/postgres:orioledb-15.1.0.55")).toBeUndefined();
  });

  it("strips vector's docker.io -alpine variant suffix", () => {
    expect(slimCatalogPin("vector", "timberio/vector:0.53.0-alpine")).toEqual({
      service: "vector",
      version: "0.53.0",
    });
  });

  it("does not strip -alpine from a non-vector service's tag", () => {
    expect(slimCatalogPin("studio", "supabase/studio:2026.08.17-alpine")).toEqual({
      service: "studio",
      version: "2026.08.17-alpine",
    });
  });

  it("is absent for aliases with no slim build", () => {
    for (const alias of ["kong", "differ", "migra", "pgprove"]) {
      expect(slimCatalogPin(alias, dockerfileServiceImageRaw(alias))).toBeUndefined();
    }
  });

  it("is absent for an untagged reference", () => {
    expect(slimCatalogPin("pg", "supabase/postgres")).toBeUndefined();
  });
});

describe("toSlimImage", () => {
  it("returns the catalog's pinned image (with its digest) when the tag matches a catalog upstream version", () => {
    expect(toSlimImage("gotrue", "supabase/gotrue:v2.197.0")).toBe(AUTH_FIXTURE_PIN_IMAGE);
    // The alias-normalization prefix (V -> v) still applies before the catalog match.
    expect(toSlimImage("gotrue", "supabase/gotrue:V2.197.0")).toBe(AUTH_FIXTURE_PIN_IMAGE);
  });

  it("returns undefined, keeping the upstream image, when the tag isn't in the catalog", () => {
    expect(toSlimImage("gotrue", "supabase/gotrue:v2.100.0")).toBeUndefined();
    // `pg` has no entry at all in this fixture catalog.
    expect(toSlimImage("pg", "supabase/postgres:17.6.1.164")).toBeUndefined();
  });

  it("returns undefined for aliases and tags slimCatalogPin already excludes", () => {
    expect(toSlimImage("pg", "supabase/postgres:16.0.0.1-orioledb")).toBeUndefined();
    expect(toSlimImage("kong", dockerfileServiceImageRaw("kong"))).toBeUndefined();
    expect(toSlimImage("pg", "supabase/postgres")).toBeUndefined();
  });
});

describe("imageTag", () => {
  it("returns the release tag, ignoring an @sha256 digest", () => {
    expect(
      imageTag(
        "ghcr.io/supabase/cli/auth:v2.197.0-r0@sha256:d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c",
      ),
    ).toBe("v2.197.0-r0");
  });

  it("returns the tag on a plain (digest-less) reference", () => {
    expect(imageTag("supabase/gotrue:v2.197.0")).toBe("v2.197.0");
  });

  it("returns undefined on an untagged reference", () => {
    expect(imageTag("supabase/postgres")).toBeUndefined();
  });
});

describe("slimImagesEnabled", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
    ["yes", false],
    ["TRUE", false],
    ["", false],
  ])("reads %j as %s", (value, expected) => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", value);
    expect(slimImagesEnabled()).toBe(expected);
  });
});

describe("slimImageForAlias", () => {
  it("is a no-op while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
    expect(slimImageForAlias("gotrue", "supabase/gotrue:v2.197.0")).toBe(
      "supabase/gotrue:v2.197.0",
    );
  });

  it("translates when the flag is on and the tag matches the catalog", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(slimImageForAlias("gotrue", "supabase/gotrue:v2.197.0")).toBe(AUTH_FIXTURE_PIN_IMAGE);
  });

  it("keeps the upstream image when the flag is on but the tag isn't in the catalog", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165")).toBe(
      "supabase/postgres:17.6.1.165",
    );
  });
});

describe("usesSlimImageRuntime", () => {
  it("is false while the flag is off even for a ghcr ref", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/postgres:17.6.1.165")).toBe(false);
  });

  it("is true only when the flag is on and the ref is slim", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/auth:v2.196.0")).toBe(true);
    expect(usesSlimImageRuntime("supabase/gotrue:v2.196.0")).toBe(false);
  });
});

describe("pinMatchesCurrentImage", () => {
  it("treats catalog-equivalent pooler tags as current", () => {
    const current = dockerfileServiceImageRaw("supavisor");
    const currentTag = current.split(":")[1] ?? "";
    const altTag = currentTag.startsWith("v") ? currentTag.slice(1) : `v${currentTag}`;
    expect(pinMatchesCurrentImage("supavisor", currentTag, current)).toBe(true);
    expect(pinMatchesCurrentImage("supavisor", altTag, current)).toBe(true);
    expect(pinMatchesCurrentImage("supavisor", "2.0.0", current)).toBe(false);
  });
});

describe("slimImageForCurrentPin", () => {
  it("slim-translates the current pin using the catalog's pinned digest", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    const current = "supabase/gotrue:v2.197.0";
    expect(slimImageForCurrentPin("gotrue", current)).toBe(AUTH_FIXTURE_PIN_IMAGE);
    expect(slimImageForCurrentPin("gotrue", current, "v2.197.0")).toBe(AUTH_FIXTURE_PIN_IMAGE);
    expect(slimImageForCurrentPin("gotrue", current, "v1.67.0")).toBe("supabase/gotrue:v1.67.0");
  });

  it("is a no-op while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "");
    const current = "supabase/gotrue:v2.197.0";
    expect(slimImageForCurrentPin("gotrue", current, "v1.67.0")).toBe("supabase/gotrue:v1.67.0");
  });
});
