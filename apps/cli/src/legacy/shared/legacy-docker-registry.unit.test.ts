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
  });
});
