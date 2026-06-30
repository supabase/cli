import { describe, expect, test } from "vitest";
import serviceImagesDockerfile from "../../../../cli-go/pkg/config/templates/Dockerfile" with { type: "text" };
import {
  dockerfileImages,
  MIRROR_REGISTRIES,
  mirrorImageTarget,
  mirrorImageTargets,
  partitionUnmirroredImages,
} from "./mirror-images.ts";

describe("mirror images", () => {
  test("mirrors an upstream image under the supabase namespace of a registry", () => {
    // Third-party orgs are dropped; only the basename is kept, matching Go's
    // utils.GetRegistryImageUrl.
    expect(mirrorImageTarget("postgrest/postgrest:v14.14", "ghcr.io")).toBe(
      "ghcr.io/supabase/postgrest:v14.14",
    );
    expect(mirrorImageTarget("library/kong:2.8.1", "public.ecr.aws")).toBe(
      "public.ecr.aws/supabase/kong:2.8.1",
    );
  });

  test("targets cover every mirror registry (ECR and ghcr.io)", () => {
    expect(MIRROR_REGISTRIES).toEqual(["public.ecr.aws", "ghcr.io"]);
    expect(mirrorImageTargets("postgrest/postgrest:v14.14")).toEqual([
      "public.ecr.aws/supabase/postgrest:v14.14",
      "ghcr.io/supabase/postgrest:v14.14",
    ]);
  });

  test("lists every FROM image pinned in the Dockerfile", () => {
    expect(
      dockerfileImages(`
        FROM postgrest/postgrest:v14.14 AS postgrest
        RUN echo ignored
        FROM supabase/logflare:1.45.6 AS logflare
      `),
    ).toEqual(["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"]);
  });

  test("includes every image in the real Dockerfile, supabase/* ones too", () => {
    const images = dockerfileImages(serviceImagesDockerfile);
    expect(images).toContain("postgrest/postgrest:v14.14");
    // No image is filtered out by org — supabase/* images are checked as well.
    expect(images.some((image) => image.startsWith("supabase/"))).toBe(true);
  });

  test("an image is mirrored only when present on ALL registries", async () => {
    const present = new Set([
      // kong is on both registries -> mirrored.
      "public.ecr.aws/supabase/kong:2.8.1",
      "ghcr.io/supabase/kong:2.8.1",
      // postgrest is only on ghcr.io -> partial mirror, must be re-pushed.
      "ghcr.io/supabase/postgrest:v14.14",
    ]);
    const queried: string[] = [];
    const isMirrored = (target: string) => {
      queried.push(target);
      return Promise.resolve(present.has(target));
    };

    const { mirrored, missing } = await partitionUnmirroredImages(
      // Duplicate kong to prove de-duplication.
      ["library/kong:2.8.1", "postgrest/postgrest:v14.14", "library/kong:2.8.1"],
      isMirrored,
    );

    expect(mirrored).toEqual(["library/kong:2.8.1"]);
    expect(missing).toEqual(["postgrest/postgrest:v14.14"]);
    // Two unique images x two registries = four checks.
    expect(queried).toHaveLength(4);
  });

  test("is a no-op once everything is on every registry (idempotent re-run)", async () => {
    const allMirrored = () => Promise.resolve(true);
    const { mirrored, missing } = await partitionUnmirroredImages(
      ["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"],
      allMirrored,
    );

    expect(missing).toEqual([]);
    expect(mirrored).toEqual(["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"]);
  });
});
