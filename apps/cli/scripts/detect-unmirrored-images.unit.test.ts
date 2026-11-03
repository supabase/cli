import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  inspectResultIsMirrored,
  inspectWithRateLimitRetry,
  MIRROR_REGISTRIES,
  mirrorImageTarget,
  mirrorImageTargets,
  partitionUnmirroredImages,
} from "./detect-unmirrored-images.ts";

describe("detect unmirrored images", () => {
  test("mirrors an upstream image under the supabase namespace of a registry", () => {
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

  it.effect("an image is mirrored only when present on ALL registries", () =>
    Effect.gen(function* () {
      const present = new Set([
        // kong is on both registries -> mirrored.
        "public.ecr.aws/supabase/kong:2.8.1",
        "ghcr.io/supabase/kong:2.8.1",
        // postgrest is only on ghcr.io -> partial mirror, must be re-pushed.
        "ghcr.io/supabase/postgrest:v14.14",
      ]);
      const queried: string[] = [];
      const isMirrored = (target: string) =>
        Effect.sync(() => {
          queried.push(target);
          return present.has(target);
        });

      const { mirrored, missing } = yield* partitionUnmirroredImages(
        // Duplicate kong to prove de-duplication.
        ["library/kong:2.8.1", "postgrest/postgrest:v14.14", "library/kong:2.8.1"],
        isMirrored,
      );

      expect(mirrored).toEqual(["library/kong:2.8.1"]);
      expect(missing).toEqual(["postgrest/postgrest:v14.14"]);
      expect(queried).toHaveLength(4);
    }),
  );

  it.effect("is a no-op once everything is on every registry (idempotent re-run)", () =>
    Effect.gen(function* () {
      const allMirrored = () => Effect.succeed(true);
      const { mirrored, missing } = yield* partitionUnmirroredImages(
        ["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"],
        allMirrored,
      );

      expect(missing).toEqual([]);
      expect(mirrored).toEqual(["postgrest/postgrest:v14.14", "supabase/logflare:1.45.6"]);
    }),
  );

  test("only a registry not-found marks an image as unmirrored", () => {
    const target = "public.ecr.aws/supabase/realtime:v2.144.2";

    expect(inspectResultIsMirrored(target, 0, "")).toBe(true);
    expect(inspectResultIsMirrored(target, 1, `ERROR: ${target}: not found\n`)).toBe(false);
  });

  test("a failed registry probe aborts detection with the registry error", () => {
    const target = "public.ecr.aws/supabase/realtime:v2.144.2";
    const stderr =
      'ERROR: failed to do request: Head "https://public.ecr.aws/v2/supabase/realtime/manifests/v2.144.2": dial tcp: i/o timeout\n';

    expect(() => inspectResultIsMirrored(target, 1, stderr)).toThrow(
      `could not inspect ${target} (exit 1): ${stderr.trim()}`,
    );
  });

  it.effect(
    "a rate-limited probe is retried with backoff and only aborts once retries run out",
    () =>
      Effect.gen(function* () {
        const target = "public.ecr.aws/supabase/postgres:17.11.0.006";
        const rateLimited = {
          exit: 1,
          stderr: "ERROR: httpReadSeeker: failed open: unexpected status: 429 Too Many Requests\n",
        };
        const slept: number[] = [];
        const sleep = (ms: number) =>
          Effect.sync(() => {
            slept.push(ms);
          });

        const quotaExceeded = { exit: 1, stderr: "ERROR: toomanyrequests: Data limit exceeded\n" };
        const responses = [rateLimited, quotaExceeded, { exit: 0, stderr: "" }];
        expect(
          yield* inspectWithRateLimitRetry(
            target,
            Effect.sync(() => responses.shift()!),
            sleep,
            [1, 2, 3],
          ),
        ).toBe(true);
        expect(slept).toEqual([1, 2]);

        const error = yield* Effect.flip(
          inspectWithRateLimitRetry(target, Effect.succeed(rateLimited), sleep, [1]),
        );
        expect(error.message).toContain("429 Too Many Requests");
      }),
  );
});
