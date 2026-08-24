import { describe, expect, it } from "vitest";

import {
  legacyGetRegistryImageUrl,
  legacyGetRegistryImageUrlCandidates,
} from "./legacy-docker-registry.ts";

describe("legacyGetRegistryImageUrl", () => {
  const withRegistry = <T>(
    value: string | undefined,
    fn: (env: Readonly<Record<string, string>>) => T,
  ): T => fn(value === undefined ? {} : { SUPABASE_INTERNAL_IMAGE_REGISTRY: value });

  it("defaults to the ECR mirror when the registry is unset", () => {
    expect(
      withRegistry(undefined, (env) => legacyGetRegistryImageUrl("supabase/pg_prove:3.36", env)),
    ).toBe("public.ecr.aws/supabase/pg_prove:3.36");
  });

  it("treats a blank registry override as unset", () => {
    expect(
      withRegistry("  ", (env) => legacyGetRegistryImageUrl("supabase/pg_prove:3.36", env)),
    ).toBe("public.ecr.aws/supabase/pg_prove:3.36");
  });

  it("returns the image unchanged for docker.io (case-insensitive)", () => {
    expect(
      withRegistry("docker.io", (env) => legacyGetRegistryImageUrl("supabase/pg_prove:3.36", env)),
    ).toBe("supabase/pg_prove:3.36");
    expect(
      withRegistry("DOCKER.IO", (env) => legacyGetRegistryImageUrl("supabase/pg_prove:3.36", env)),
    ).toBe("supabase/pg_prove:3.36");
  });

  it("rewrites to <registry>/supabase/<image> for a custom mirror", () => {
    expect(
      withRegistry("my.mirror.example", (env) =>
        legacyGetRegistryImageUrl("supabase/pg_prove:3.36", env),
      ),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
  });

  it("returns fallback candidates when the registry is unset", () => {
    expect(
      withRegistry(undefined, (env) =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", env),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("dedupes an already-defaulted image in the fallback candidates", () => {
    expect(
      withRegistry(undefined, (env) =>
        legacyGetRegistryImageUrlCandidates("public.ecr.aws/supabase/postgres:17.6.1.138", env),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("uses a single candidate when the registry is explicitly configured", () => {
    expect(
      withRegistry("public.ecr.aws", (env) =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", env),
      ),
    ).toEqual(["public.ecr.aws/supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("docker.io", (env) =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", env),
      ),
    ).toEqual(["supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("my.mirror.example", (env) =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", env),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  // `Config.Load` runs `loadNestedEnv`/`godotenv.Load`
  // before any image resolution, so a project-dotenv-only `SUPABASE_INTERNAL_IMAGE_REGISTRY`
  // (never set in the ambient shell) still reaches `GetRegistry()`.
  it("honors a projectEnvValues (dotenv)-only registry override, matching Go's post-Load os.Getenv", () => {
    expect(
      withRegistry(undefined, (env) =>
        legacyGetRegistryImageUrl("supabase/pg_prove:3.36", {
          ...env,
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
    expect(
      withRegistry(undefined, (env) =>
        legacyGetRegistryImageUrlCandidates("supabase/postgres:17.6.1.138", {
          ...env,
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  it("uses the caller-provided merged environment", () => {
    expect(
      withRegistry("ambient.example", () =>
        legacyGetRegistryImageUrl("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "merged.example",
        }),
      ),
    ).toBe("merged.example/supabase/pg_prove:3.36");
  });
});
