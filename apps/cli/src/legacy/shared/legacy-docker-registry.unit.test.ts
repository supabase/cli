import { describe, expect, it } from "vitest";

import { legacyGetRegistryImageUrl } from "./legacy-docker-registry.ts";

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
});
