import { afterEach, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { vi } from "vitest";

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

// Only `auth` and one OrioleDB postgres build are pinned, so every other alias falls through to
// its upstream image. `vi.mock` factories are hoisted above top-level statements, so the fixture
// is inlined.
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
      {
        service: "database",
        sourceService: "postgres",
        pin: {
          upstreamVersion: "17.11.0.002-orioledb",
          revision: 0,
          image: `ghcr.io/supabase/cli/postgres:17.11.0.002-orioledb-r0@sha256:${digest}`,
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
const ORIOLEDB_FIXTURE_PIN_IMAGE =
  "ghcr.io/supabase/cli/postgres:17.11.0.002-orioledb-r0@sha256:d348483ad1141c54bfb4eaae801f5385fe1c2970fc106f95f531b5247092d52c";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slimCatalogPin", () => {
  it.each([
    ["pg", "postgres"],
    ["pg15", "postgres"],
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

  it("keeps an OrioleDB tag whole, so it matches only an OrioleDB catalog pin", () => {
    expect(slimCatalogPin("pg", "supabase/postgres:17.11.0.002-orioledb")).toEqual({
      service: "postgres",
      version: "17.11.0.002-orioledb",
    });
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
    for (const alias of ["kong", "pg14", "differ", "migra", "pgprove"]) {
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
    // `pg` has only an OrioleDB entry in this fixture catalog.
    expect(toSlimImage("pg", "supabase/postgres:17.6.1.164")).toBeUndefined();
  });

  it("maps a pinned OrioleDB tag to its catalog image and keeps unpinned ones upstream", () => {
    expect(toSlimImage("pg", "supabase/postgres:17.11.0.002-orioledb")).toBe(
      ORIOLEDB_FIXTURE_PIN_IMAGE,
    );
    expect(toSlimImage("pg", "supabase/postgres:17.11.0.002")).toBeUndefined();
    expect(toSlimImage("pg", "supabase/postgres:16.0.0.1-orioledb")).toBeUndefined();
    expect(toSlimImage("pg", "supabase/postgres:orioledb-15.1.0.55")).toBeUndefined();
  });

  it("returns undefined for aliases and tags slimCatalogPin already excludes", () => {
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect.each([
    { value: "true", expected: true },
    { value: "1", expected: true },
    { value: "false", expected: false },
    { value: "0", expected: false },
    { value: "yes", expected: false },
    { value: "TRUE", expected: false },
    { value: "", expected: false },
    { value: undefined, expected: false },
  ])("reads $value as $expected", ({ value, expected }) =>
    Effect.gen(function* () {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", value);
      expect(yield* slimImagesEnabled).toBe(expected);
    }),
  );

  it.effect("reads the process environment, not the active ConfigProvider", () =>
    Effect.gen(function* () {
      vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
      const pinned = ConfigProvider.fromEnvRecord({ SUPABASE_USE_SLIM_IMAGES: "true" });
      const failing = ConfigProvider.make(() =>
        Effect.fail(new ConfigProvider.SourceError({ message: "injected" })),
      );
      for (const provider of [pinned, failing]) {
        expect(
          yield* slimImagesEnabled.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, provider),
          ),
        ).toBe(false);
      }
    }),
  );
});

describe("slimImageForAlias", () => {
  it("is a no-op while the flag is off", () => {
    expect(slimImageForAlias("gotrue", "supabase/gotrue:v2.197.0", false)).toBe(
      "supabase/gotrue:v2.197.0",
    );
  });

  it("translates when the flag is on and the tag matches the catalog", () => {
    expect(slimImageForAlias("gotrue", "supabase/gotrue:v2.197.0", true)).toBe(
      AUTH_FIXTURE_PIN_IMAGE,
    );
  });

  it("keeps the upstream image when the flag is on but the tag isn't in the catalog", () => {
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165", true)).toBe(
      "supabase/postgres:17.6.1.165",
    );
  });
});

describe("usesSlimImageRuntime", () => {
  it("is false while the flag is off even for a ghcr ref", () => {
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/postgres:17.6.1.165", false)).toBe(false);
  });

  it("is true only when the flag is on and the ref is slim", () => {
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/auth:v2.196.0", true)).toBe(true);
    expect(usesSlimImageRuntime("supabase/gotrue:v2.196.0", true)).toBe(false);
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
    const current = "supabase/gotrue:v2.197.0";
    expect(slimImageForCurrentPin("gotrue", current, undefined, true)).toBe(AUTH_FIXTURE_PIN_IMAGE);
    expect(slimImageForCurrentPin("gotrue", current, "v2.197.0", true)).toBe(
      AUTH_FIXTURE_PIN_IMAGE,
    );
    expect(slimImageForCurrentPin("gotrue", current, "v1.67.0", true)).toBe(
      "supabase/gotrue:v1.67.0",
    );
  });

  it("is a no-op while the flag is off", () => {
    const current = "supabase/gotrue:v2.197.0";
    expect(slimImageForCurrentPin("gotrue", current, "v1.67.0", false)).toBe(
      "supabase/gotrue:v1.67.0",
    );
  });

  it("falls back to the upstream image on the linked-pin fallback path (a hosted version that doesn't match the pin)", () => {
    const current = "supabase/gotrue:v2.197.0";
    // The linked project's hosted version (v1.67.0) differs from the catalog's pinned
    // upstream version (v2.197.0): stay on the upstream (non-slim) image instead of guessing.
    expect(slimImageForCurrentPin("gotrue", current, "v1.67.0", true)).toBe(
      "supabase/gotrue:v1.67.0",
    );
  });
});
