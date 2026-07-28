import { describe, expect, it } from "vitest";

import {
  legacyGetRegistryImageUrl,
  legacyGetRegistryImageUrlCandidates,
} from "./legacy-docker-registry.ts";

describe("legacyGetRegistryImageUrl", () => {
  const withRegistry = <T>(value: string | undefined, fn: () => T): T => {
    const prev = process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
    if (value === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
    else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"];
      else process.env["SUPABASE_INTERNAL_IMAGE_REGISTRY"] = prev;
    }
  };

  it("defaults to the ECR mirror when the registry is unset", () => {
    expect(withRegistry(undefined, () => legacyGetRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("treats a blank registry override as unset", () => {
    expect(withRegistry("  ", () => legacyGetRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("returns the image unchanged for docker.io (case-insensitive)", () => {
    expect(
      withRegistry("docker.io", () => legacyGetRegistryImageUrl("supabase/pg_prove:3.36")),
    ).toBe("supabase/pg_prove:3.36");
    expect(
      withRegistry("DOCKER.IO", () => legacyGetRegistryImageUrl("supabase/pg_prove:3.36")),
    ).toBe("supabase/pg_prove:3.36");
  });

  it("rewrites to <registry>/supabase/<image> for a custom mirror", () => {
    expect(
      withRegistry("my.mirror.example", () => legacyGetRegistryImageUrl("supabase/pg_prove:3.36")),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
  });

  it("returns fallback candidates when the registry is unset", () => {
    expect(
      withRegistry(undefined, () =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("dedupes an already-defaulted image in the fallback candidates", () => {
    expect(
      withRegistry(undefined, () =>
        legacyGetRegistryImageUrlCandidates("public.ecr.aws/supabase/postgres:17.6.1.138"),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("uses a single candidate when the registry is explicitly configured", () => {
    expect(
      withRegistry("public.ecr.aws", () =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["public.ecr.aws/supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("docker.io", () =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("my.mirror.example", () =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  // Go's `Config.Load` runs `loadNestedEnv`/`godotenv.Load` (`pkg/config/config.go:789,1220-1258`)
  // before any image resolution, so a project-dotenv-only `SUPABASE_INTERNAL_IMAGE_REGISTRY`
  // (never set in the ambient shell) still reaches `GetRegistry()`.
  it("honors a projectEnvValues (dotenv)-only registry override, matching Go's post-Load os.Getenv", () => {
    expect(
      withRegistry(undefined, () =>
        legacyGetRegistryImageUrl("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
    expect(
      withRegistry(undefined, () =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  // `projectEnvValues` is the caller's own dotenv+ambient MERGED view (ambient
  // wins ties during that merge, matching `godotenv.Load`'s "don't override
  // already-set" semantics — see `legacyEnvOrDefault`'s doc comment for the
  // same precedent), so checking it first is equivalent to checking the
  // already-correctly-merged value first; falling back to bare `process.env`
  // only covers a caller with no project-env context at all.
  it("prefers projectEnvValues over a bare process.env read when both are set", () => {
    expect(
      withRegistry("ambient.example", () =>
        legacyGetRegistryImageUrl("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "merged.example",
        }),
      ),
    ).toBe("merged.example/supabase/pg_prove:3.36");
  });
});
