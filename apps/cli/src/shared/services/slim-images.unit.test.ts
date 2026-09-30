import { afterEach, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { vi } from "vitest";

import { dockerfileServiceImageRaw } from "./dockerfile-images.ts";
import {
  pinMatchesCurrentImage,
  slimCatalogPin,
  slimImageForAlias,
  slimImageForCurrentPin,
  slimImagesEnabled,
  toSlimImage,
  usesSlimImageRuntime,
} from "./slim-images.ts";

describe("toSlimImage", () => {
  it.each([
    ["pg", "ghcr.io/supabase/cli/postgres"],
    ["gotrue", "ghcr.io/supabase/cli/auth"],
    ["postgrest", "ghcr.io/supabase/cli/postgrest"],
    ["realtime", "ghcr.io/supabase/cli/realtime"],
    ["storage", "ghcr.io/supabase/cli/storage"],
    ["edgeruntime", "ghcr.io/supabase/cli/edge-runtime"],
    ["studio", "ghcr.io/supabase/cli/studio"],
    ["pgmeta", "ghcr.io/supabase/cli/pgmeta"],
    ["logflare", "ghcr.io/supabase/cli/analytics"],
    ["supavisor", "ghcr.io/supabase/cli/pooler"],
    ["vector", "ghcr.io/supabase/cli/vector"],
    ["imgproxy", "ghcr.io/supabase/cli/imgproxy"],
    ["mailpit", "ghcr.io/supabase/cli/mailpit"],
  ])("maps the %s manifest pin onto %s", (alias, repository) => {
    const translated = toSlimImage(alias, dockerfileServiceImageRaw(alias));
    expect(translated.slice(0, translated.lastIndexOf(":"))).toBe(repository);
  });

  it("keeps a non-current pin instead of the catalog default", () => {
    expect(toSlimImage("pg", "supabase/postgres:17.6.1.164")).toBe(
      "ghcr.io/supabase/cli/postgres:17.6.1.164",
    );
    expect(toSlimImage("studio", "supabase/studio:2026.08.17-sha-0c1da8f")).toBe(
      "ghcr.io/supabase/cli/studio:2026.08.17-sha-0c1da8f",
    );
  });

  // Fixed pins, not manifest pins: dependabot bumps the manifest, so spelling
  // out a current pin here would fail on every bump. The `it.each` above covers
  // the part that must track it (the repository each alias maps to).
  it("keeps a single v on pins already prefixed on docker.io", () => {
    expect(toSlimImage("realtime", "supabase/realtime:v2.130.0")).toBe(
      "ghcr.io/supabase/cli/realtime:v2.130.0",
    );
    expect(toSlimImage("storage", "supabase/storage-api:v1.72.1")).toBe(
      "ghcr.io/supabase/cli/storage:v1.72.1",
    );
    expect(toSlimImage("gotrue", "supabase/gotrue:V2.196.0")).toBe(
      "ghcr.io/supabase/cli/auth:v2.196.0",
    );
  });

  it("v-prefixes pins whose slim tag scheme differs from docker.io's", () => {
    expect(toSlimImage("supavisor", "supabase/supavisor:2.9.10")).toBe(
      "ghcr.io/supabase/cli/pooler:v2.9.10",
    );
    expect(toSlimImage("logflare", "supabase/logflare:1.50.4")).toBe(
      "ghcr.io/supabase/cli/analytics:v1.50.4",
    );
    expect(toSlimImage("pgmeta", "supabase/postgres-meta:v0.98.0")).toBe(
      "ghcr.io/supabase/cli/pgmeta:v0.98.0",
    );
  });

  it("keeps OrioleDB tags on docker.io", () => {
    expect(toSlimImage("pg", "supabase/postgres:16.0.0.1-orioledb")).toBe(
      "supabase/postgres:16.0.0.1-orioledb",
    );
    expect(toSlimImage("pg", "supabase/postgres:orioledb-15.1.0.55")).toBe(
      "supabase/postgres:orioledb-15.1.0.55",
    );
    expect(slimCatalogPin("pg", "supabase/postgres:16.0.0.1-orioledb")).toBeUndefined();
  });

  it("strips vector's docker.io -alpine variant suffix", () => {
    expect(toSlimImage("vector", "timberio/vector:0.53.0-alpine")).toBe(
      "ghcr.io/supabase/cli/vector:0.53.0",
    );
  });

  it("does not strip -alpine from a non-vector service's tag", () => {
    expect(toSlimImage("studio", "supabase/studio:2026.08.17-alpine")).toBe(
      "ghcr.io/supabase/cli/studio:2026.08.17-alpine",
    );
  });

  it("passes through aliases with no slim build", () => {
    for (const alias of ["kong", "differ", "migra", "pgprove"]) {
      const image = dockerfileServiceImageRaw(alias);
      expect(toSlimImage(alias, image)).toBe(image);
    }
  });

  it("passes through an untagged reference", () => {
    expect(toSlimImage("pg", "supabase/postgres")).toBe("supabase/postgres");
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
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165", false)).toBe(
      "supabase/postgres:17.6.1.165",
    );
  });

  it("translates when the flag is on", () => {
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165", true)).toBe(
      "ghcr.io/supabase/cli/postgres:17.6.1.165",
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
  it("slim-translates the current pin and leaves a historical pin on docker.io", () => {
    const current = dockerfileServiceImageRaw("storage");
    const currentTag = current.split(":")[1] ?? "";
    expect(slimImageForCurrentPin("storage", current, undefined, true)).toBe(
      toSlimImage("storage", current),
    );
    expect(slimImageForCurrentPin("storage", current, currentTag, true)).toBe(
      toSlimImage("storage", current),
    );
    expect(slimImageForCurrentPin("storage", current, "v1.67.0", true)).toBe(
      "supabase/storage-api:v1.67.0",
    );
  });

  it("is a no-op while the flag is off", () => {
    const current = dockerfileServiceImageRaw("storage");
    expect(slimImageForCurrentPin("storage", current, "v1.67.0", false)).toBe(
      "supabase/storage-api:v1.67.0",
    );
  });
});
