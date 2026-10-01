import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect } from "effect";
import { runDocker } from "./docker-fixture.ts";
import { removeTestRunVolumes } from "./docker-volume-run.ts";

const volumeExists = Effect.fn("DockerVolumeRunTest.volumeExists")((name: string) =>
  runDocker(["volume", "inspect", name]).pipe(Effect.map((result) => result.code === 0)),
);

describe("test-run Docker volume cleanup", { timeout: 120_000 }, () => {
  it.live("removes exactly the volumes labelled for this run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const suffix = (yield* crypto.randomUUIDv4).slice(0, 8);
        const runId = `run-${suffix}`;
        const otherRunId = `other-run-${suffix}`;
        const owned = `sb-test-run-owned-${suffix}`;
        const foreign = `sb-test-run-foreign-${suffix}`;
        const unlabelled = `sb-test-run-unlabelled-${suffix}`;

        yield* runDocker([
          "volume",
          "create",
          "--label",
          "com.supabase.stack-managed=true",
          "--label",
          `com.supabase.stack-test-run=${runId}`,
          owned,
        ]);
        yield* runDocker([
          "volume",
          "create",
          "--label",
          "com.supabase.stack-managed=true",
          "--label",
          `com.supabase.stack-test-run=${otherRunId}`,
          foreign,
        ]);
        yield* runDocker([
          "volume",
          "create",
          "--label",
          "com.supabase.stack-managed=true",
          unlabelled,
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [owned, foreign, unlabelled],
            (name) => runDocker(["volume", "rm", name]).pipe(Effect.ignore),
            { discard: true },
          ),
        );

        yield* removeTestRunVolumes(runId);

        expect(yield* volumeExists(owned)).toBe(false);
        expect(yield* volumeExists(foreign)).toBe(true);
        expect(yield* volumeExists(unlabelled)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
