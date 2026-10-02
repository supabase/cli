import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { getRegistryImageUrl, getRegistryImageUrlCandidates } from "./docker-registry.ts";

describe("getRegistryImageUrl", () => {
  const resolveImage = (image: string, env?: Readonly<Record<string, string>>) =>
    Effect.runSync(
      getRegistryImageUrl(image, env).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ ...process.env }, { preserveEmptyStrings: true }),
        ),
      ),
    );
  const resolveCandidates = (image: string, env?: Readonly<Record<string, string>>) =>
    Effect.runSync(
      getRegistryImageUrlCandidates(image, env).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ ...process.env }, { preserveEmptyStrings: true }),
        ),
      ),
    );
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
    expect(withRegistry(undefined, () => resolveImage("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("treats a blank registry override as unset", () => {
    expect(withRegistry("  ", () => resolveImage("supabase/pg_prove:3.36"))).toBe(
      "public.ecr.aws/supabase/pg_prove:3.36",
    );
  });

  it("returns the image unchanged for docker.io (case-insensitive)", () => {
    expect(withRegistry("docker.io", () => resolveImage("supabase/pg_prove:3.36"))).toBe(
      "supabase/pg_prove:3.36",
    );
    expect(withRegistry("DOCKER.IO", () => resolveImage("supabase/pg_prove:3.36"))).toBe(
      "supabase/pg_prove:3.36",
    );
  });

  it("rewrites to <registry>/supabase/<image> for a custom mirror", () => {
    expect(withRegistry("my.mirror.example", () => resolveImage("supabase/pg_prove:3.36"))).toBe(
      "my.mirror.example/supabase/pg_prove:3.36",
    );
  });

  it("returns fallback candidates when the registry is unset", () => {
    expect(
      withRegistry(undefined, () => resolveCandidates("supabase/postgres:17.6.1.138")),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("dedupes an already-defaulted image in the fallback candidates", () => {
    expect(
      withRegistry(undefined, () =>
        resolveCandidates("public.ecr.aws/supabase/postgres:17.6.1.138"),
      ),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6.1.138",
      "ghcr.io/supabase/postgres:17.6.1.138",
      "supabase/postgres:17.6.1.138",
    ]);
  });

  it("uses a single candidate when the registry is explicitly configured", () => {
    expect(
      withRegistry("public.ecr.aws", () => resolveCandidates("supabase/postgres:17.6.1.138")),
    ).toEqual(["public.ecr.aws/supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("docker.io", () => resolveCandidates("supabase/postgres:17.6.1.138")),
    ).toEqual(["supabase/postgres:17.6.1.138"]);
    expect(
      withRegistry("my.mirror.example", () => resolveCandidates("supabase/postgres:17.6.1.138")),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  it("honors a projectEnvValues (dotenv)-only registry override, matching Go's post-Load os.Getenv", () => {
    expect(
      withRegistry(undefined, () =>
        resolveImage("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe("my.mirror.example/supabase/pg_prove:3.36");
    expect(
      withRegistry(undefined, () =>
        resolveCandidates("supabase/postgres:17.6.1.138", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual(["my.mirror.example/supabase/postgres:17.6.1.138"]);
  });

  it("prefers projectEnvValues over a bare process.env read when both are set", () => {
    expect(
      withRegistry("ambient.example", () =>
        resolveImage("supabase/pg_prove:3.36", {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "merged.example",
        }),
      ),
    ).toBe("merged.example/supabase/pg_prove:3.36");
  });

  // Published only under ghcr.io/supabase/cli; rewriting by last path segment would misroute it.
  const SLIM_IMAGE = "ghcr.io/supabase/cli/postgres:17.6.1.165";

  it("leaves a slim image unrewritten, whatever the registry override says", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(withRegistry(registry, () => resolveImage(SLIM_IMAGE))).toBe(SLIM_IMAGE);
    }
    expect(
      withRegistry(undefined, () =>
        resolveImage(SLIM_IMAGE, {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toBe(SLIM_IMAGE);
  });

  it("plans a single pull candidate for a slim image", () => {
    for (const registry of [undefined, "public.ecr.aws", "docker.io", "my.mirror.example"]) {
      expect(withRegistry(registry, () => resolveCandidates(SLIM_IMAGE))).toEqual([SLIM_IMAGE]);
    }
    expect(
      withRegistry(undefined, () =>
        resolveCandidates(SLIM_IMAGE, {
          SUPABASE_INTERNAL_IMAGE_REGISTRY: "my.mirror.example",
        }),
      ),
    ).toEqual([SLIM_IMAGE]);
  });

  it("still rewrites the non-slim ghcr.io/supabase namespace", () => {
    expect(withRegistry("docker.io", () => resolveImage("ghcr.io/supabase/postgres:17.6"))).toBe(
      "ghcr.io/supabase/postgres:17.6",
    );
    expect(
      withRegistry(undefined, () => resolveCandidates("ghcr.io/supabase/postgres:17.6")),
    ).toEqual([
      "public.ecr.aws/supabase/postgres:17.6",
      "ghcr.io/supabase/postgres:17.6",
      "supabase/postgres:17.6",
    ]);
  });
});
