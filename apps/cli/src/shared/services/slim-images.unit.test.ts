import { afterEach, describe, expect, it, vi } from "vitest";

import { dockerfileServiceImages } from "./dockerfile-images.ts";
import {
  slimImageForAlias,
  slimImagesEnabled,
  toSlimImage,
  usesSlimImageRuntime,
} from "./slim-images.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const imageForAlias = (alias: string): string => {
  const spec = dockerfileServiceImages.find((image) => image.alias === alias);
  if (spec === undefined) {
    throw new Error(`Missing service image alias '${alias}' in Dockerfile manifest.`);
  }
  return spec.image;
};

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
    const translated = toSlimImage(alias, imageForAlias(alias));
    expect(translated.slice(0, translated.lastIndexOf(":"))).toBe(repository);
  });

  it("keeps the Dockerfile version pin instead of the catalog default", () => {
    expect(toSlimImage("pg", "supabase/postgres:17.6.1.165")).toBe(
      "ghcr.io/supabase/cli/postgres:17.6.1.165",
    );
    expect(toSlimImage("studio", "supabase/studio:2026.08.17-sha-0c1da8f")).toBe(
      "ghcr.io/supabase/cli/studio:2026.08.17-sha-0c1da8f",
    );
  });

  it("v-prefixes pins whose slim tag scheme differs from docker.io's", () => {
    expect(toSlimImage("supavisor", "supabase/supavisor:2.9.7")).toBe(
      "ghcr.io/supabase/cli/pooler:v2.9.7",
    );
    expect(toSlimImage("logflare", "supabase/logflare:1.50.4")).toBe(
      "ghcr.io/supabase/cli/analytics:v1.50.4",
    );
    expect(toSlimImage("pgmeta", "supabase/postgres-meta:v0.98.0")).toBe(
      "ghcr.io/supabase/cli/pgmeta:v0.98.0",
    );
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
      const image = imageForAlias(alias);
      expect(toSlimImage(alias, image)).toBe(image);
    }
  });

  it("passes through an untagged reference", () => {
    expect(toSlimImage("pg", "supabase/postgres")).toBe("supabase/postgres");
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

  it("is off when unset", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(slimImagesEnabled()).toBe(false);
  });
});

describe("slimImageForAlias", () => {
  it("is a no-op while the flag is off", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165")).toBe(
      "supabase/postgres:17.6.1.165",
    );
  });

  it("translates when the flag is on", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "true");
    expect(slimImageForAlias("pg", "supabase/postgres:17.6.1.165")).toBe(
      "ghcr.io/supabase/cli/postgres:17.6.1.165",
    );
  });
});

describe("usesSlimImageRuntime", () => {
  it("is false while the flag is off even for a ghcr ref", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", undefined);
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/postgres:17.6.1.165")).toBe(false);
  });

  it("is true only when the flag is on and the ref is slim", () => {
    vi.stubEnv("SUPABASE_USE_SLIM_IMAGES", "1");
    expect(usesSlimImageRuntime("ghcr.io/supabase/cli/auth:v2.196.0")).toBe(true);
    expect(usesSlimImageRuntime("supabase/gotrue:v2.196.0")).toBe(false);
  });
});
