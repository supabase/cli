import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { getRegistryImageUrl, getRegistryImageUrlCandidates } from "./docker-registry.ts";

describe("getRegistryImageUrl", () => {
  const shellEnv = (registry: string | undefined) =>
    ConfigProvider.fromEnvRecord(
      registry === undefined ? {} : { SUPABASE_INTERNAL_IMAGE_REGISTRY: registry },
      { preserveEmptyStrings: true },
    );
  const resolveImage = (
    registry: string | undefined,
    image: string,
    env?: Readonly<Record<string, string>>,
  ) =>
    Effect.runSync(
      getRegistryImageUrl(image, env).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, shellEnv(registry)),
      ),
    );
  const resolveCandidates = (
    registry: string | undefined,
    image: string,
    env?: Readonly<Record<string, string>>,
  ) =>
    Effect.runSync(
      getRegistryImageUrlCandidates(image, env).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, shellEnv(registry)),
      ),
    );

  it("defaults to the ECR mirror when the registry is unset", () => {
    expect(resolveImage(undefined, "supabase/pg_prove:3.36")).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("treats a blank registry override as unset", () => {
    expect(resolveImage("  ", "supabase/pg_prove:3.36")).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("returns the image unchanged for docker.io (case-insensitive)", () => {
    expect(resolveImage("docker.io", "supabase/pg_prove:3.36")).toBe("supabase/pg_prove:3.36");
    expect(resolveImage("DOCKER.IO", "supabase/pg_prove:3.36")).toBe("supabase/pg_prove:3.36");
  });

  it("rewrites to <registry>/supabase/<image> for a custom mirror", () => {
    expect(resolveImage("my.mirror.example", "supabase/pg_prove:3.36")).toBe(
      "my.mirror.example/supabase/pg_prove:3.36",
    );
  });

  it("returns fallback candidates when the registry is unset", () => {
    expect(resolveCandidates(undefined, "supabase/postgres:17.6.1.138")).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("dedupes an already-defaulted image in the fallback candidates", () => {
    expect(resolveCandidates(undefined, "public.ecr.aws/supabase/postgres:17.6.1.138")).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("uses a single candidate when the registry is explicitly configured", () => {
    expect(resolveCandidates("public.ecr.aws", "supabase/postgres:17.6.1.138")).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
    ]);
    expect(resolveCandidates("docker.io", "supabase/postgres:17.6.1.138")).toEqual([
      "supabase/postgres:17.6.1.138",
    ]);
    expect(resolveCandidates("my.mirror.example", "supabase/postgres:17.6.1.138")).toEqual([
      "my.mirror.example/supabase/postgres:17.6.1.138",
    ]);
  });

  it("honors a projectEnvValues (dotenv)-only registry override, matching Go's post-Load os.Getenv", () => {
    expect(
      resolveImage(undefined, "supabase/pg_prove:3.36", {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
      }),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
    expect(
      resolveCandidates(undefined, "supabase/postgres:17.6.1.138", {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
      }),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  it("prefers projectEnvValues over a bare process.env read when both are set", () => {
    expect(
      resolveImage("ambient.example", "supabase/pg_prove:3.36", {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "merged.example",
      }),
    ).toBe("merged.example/supabase/pg_prove:3.36");
  });

  // Published only under ghcr.io/supabase/cli; rewriting by last path segment would misroute it.
  const SLIM_IMAGE = "ghcr.io/supabase/cli/postgres:17.6.1.165";

  it("leaves a slim image unrewritten, whatever the registry override says", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(resolveImage(registry, SLIM_IMAGE)).toBe(SLIM_IMAGE);
    }
    expect(
      resolveImage(undefined, SLIM_IMAGE, {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
      }),
    ).toBe(SLIM_IMAGE);
  });

  it("plans a single pull candidate for a slim image", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(resolveCandidates(registry, SLIM_IMAGE)).toEqual([SLIM_IMAGE]);
    }
    expect(
      resolveCandidates(undefined, SLIM_IMAGE, {
        SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
      }),
    ).toEqual([SLIM_IMAGE]);
  });

  it("still rewrites the non-slim ghcr.io/supabase namespace", () => {
    expect(resolveImage("docker.io", "ghcr.io/supabase/postgres:17.6")).toBe(
      "ghcr.io/supabase/postgres:17.6",
    );
    expect(resolveCandidates(undefined, "ghcr.io/supabase/postgres:17.6")).toEqual([
      "public.ecr.aws/supabase/postgres:17.6",
      "ghcr.io/supabase/postgres:17.6",
      "supabase/postgres:17.6",
    ]);
  });
});
