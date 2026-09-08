import { describe, expect, it } from "vitest";

import { getRegistryImageUrl, getRegistryImageUrlCandidates } from "./docker-registry.ts";

describe("getRegistryImageUrl", () => {
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
    expect(withRegistry(undefined, () => getRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("treats a blank registry override as unset", () => {
    expect(withRegistry("  ", () => getRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("returns the image unchanged for docker.io (case-insensitive)", () => {
    expect(withRegistry("docker.io", () => getRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "supabase/pg_prove:3.36",
    );
    expect(withRegistry("DOCKER.IO", () => getRegistryImageUrl("supabase/pg_prove:3.36"))).toBe(
      "supabase/pg_prove:3.36",
    );
  });

  it("rewrites to <registry>/supabase/<image> for a custom mirror", () => {
    expect(
      withRegistry("my.mirror.example", () => getRegistryImageUrl("supabase/pg_prove:3.36")),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
  });

  it("returns fallback candidates when the registry is unset", () => {
    expect(
      withRegistry(undefined, () => getRegistryImageUrlCandidates("supabase/postgres:17.6.1.138")),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("dedupes an already-defaulted image in the fallback candidates", () => {
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrlCandidates("public.ecr.aws/supabase/postgres:17.6.1.138"),
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
        getRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["public.ecr.aws/supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("docker.io", () =>
        getRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("my.mirror.example", () =>
        getRegistryImageUrlCandidates("supabase/postgres:17.6.1.138"),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  // `Config.Load` runs `loadNestedEnv`/`godotenv.Load`
  // before any image resolution, so a project-dotenv-only `SUPABASE_INTERNAL_IMAGE_REGISTRY`
  // (never set in the ambient shell) still reaches `GetRegistry()`.
  it("honors a projectEnvValues (dotenv)-only registry override, matching Go's post-Load os.Getenv", () => {
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrl("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  // `projectEnvValues` is the caller's own dotenv+ambient MERGED view (ambient
  // wins ties during that merge, matching `godotenv.Load`'s "don't override
  // already-set" semantics — see `envOrDefault`'s doc comment for the
  // same precedent), so checking it first is equivalent to checking the
  // already-correctly-merged value first; falling back to bare `process.env`
  // only covers a caller with no project-env context at all.
  it("prefers projectEnvValues over a bare process.env read when both are set", () => {
    expect(
      withRegistry("ambient.example", () =>
        getRegistryImageUrl("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "merged.example",
        }),
      ),
    ).toBe("merged.example/supabase/pg_prove:3.36");
  });

  // Slim images are published only under `ghcr.io/supabase/cli`. Rewriting them
  // by last path segment would silently pull the unrelated non-slim mirror, and
  // no mirror of them exists for a registry override to point at.
  const SLIM_IMAGE = "ghcr.io/supabase/cli/postgres:17.6.1.165";

  it("leaves a slim image unrewritten, whatever the registry override says", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(withRegistry(registry, () => getRegistryImageUrl(SLIM_IMAGE))).toBe(SLIM_IMAGE);
    }
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrl(SLIM_IMAGE, {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe(SLIM_IMAGE);
  });

  it("plans a single pull candidate for a slim image", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(withRegistry(registry, () => getRegistryImageUrlCandidates(SLIM_IMAGE))).toEqual([
        SLIM_IMAGE,
      ]);
    }
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrlCandidates(SLIM_IMAGE, {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual([SLIM_IMAGE]);
  });

  it("still rewrites the non-slim ghcr.io/supabase namespace", () => {
    expect(
      withRegistry("docker.io", () => getRegistryImageUrl("ghcr.io/supabase/postgres:17.6")),
    ).toBe("ghcr.io/supabase/postgres:17.6");
    expect(
      withRegistry(undefined, () =>
        getRegistryImageUrlCandidates("ghcr.io/supabase/postgres:17.6"),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6",
      "ghcr.io/supabase/postgres:17.6",
      "supabase/postgres:17.6",
    ]);
  });
});
