import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  MIRROR_REGISTRIES,
  mirrorImageTarget,
  mirrorImageTargets,
  partitionUnmirroredImages,
} from "./detect-unmirrored-images.ts";

describe("detect unmirrored images", () => {
  it("mirrors an upstream image under the supabase namespace of a registry", () => {
    // Third-party orgs are dropped; only the basename is kept, matching Go's
    // utils.GetRegistryImageUrl.
    expect(mirrorImageTarget("postgrest/postgrest:v14.14", "ghcr.io")).toBe(
      "ghcr.io/supabase/postgrest:v14.14",
    );
    expect(mirrorImageTarget("library/kong:2.8.1", "public.ecr.aws")).toBe(
      "public.ecr.aws/supabase/kong:2.8.1",
    );
  });

  it("targets cover every mirror registry (ECR and ghcr.io)", () => {
    expect(MIRROR_REGISTRIES).toEqual(["public.ecr.aws", "ghcr.io"]);
    expect(mirrorImageTargets("postgrest/postgrest:v14.14")).toEqual([
      "public.ecr.aws/supabase/postgrest:v14.14",
      "ghcr.io/supabase/postgrest:v14.14",
    ]);
  });

  it.effect("an image is mirrored only when present on ALL registries", () => {
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
      return Effect.succeed(present.has(target));
    };

    return Effect.gen(function* () {
      const { mirrored, missing } = yield* partitionUnmirroredImages(
        // Duplicate kong to prove de-duplication.
        ["library/kong:2.8.1", "postgrest/postgrest:v14.14", "library/kong:2.8.1"],
        isMirrored,
      );

      expect(mirrored).toEqual(["library/kong:2.8.1"]);
      expect(missing).toEqual(["postgrest/postgrest:v14.14"]);
      // Two unique images x two registries = four checks.
      expect(queried).toHaveLength(4);
    });
  });

  it.effect("is a no-op once everything is on every registry (idempotent re-run)", () => {
    const allMirrored = () => Effect.succeed(true);
    return Effect.gen(function* () {
      const { mirrored, missing } = yield* partitionUnmirroredImages(
        ["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"],
        allMirrored,
      );

      expect(missing).toEqual([]);
      expect(mirrored).toEqual(["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"]);
    });
  });
});
