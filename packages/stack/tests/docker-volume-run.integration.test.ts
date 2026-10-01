import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect } from "effect";
import { runDocker } from "./docker-fixture.ts";
import { removeTestRunVolumes } from "./docker-volume-run.ts";

const volumeExists = Effect.fn("DockerVolumeRunTest.volumeExists")((name: string) =>
  runDocker(["volume", "inspect", name]).pipe(Effect.map((result) => result.code === 0)),
);

const createVolume = Effect.fn("DockerVolumeRunTest.createVolume")(
  (name: string, labels: ReadonlyArray<string>) =>
    runDocker(["volume", "create", ...labels.flatMap((label) => ["--label", label]), name]).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.die(`docker volume create ${name} failed: ${result.output}`),
      ),
    ),
);

const removeVolume = Effect.fn("DockerVolumeRunTest.removeVolume")((name: string) =>
  runDocker(["volume", "rm", name]).pipe(
    Effect.flatMap((result) =>
      result.code === 0 || /no such volume/iu.test(result.output)
        ? Effect.void
        : Effect.die(`docker volume rm ${name} failed: ${result.output}`),
    ),
    Effect.orDie,
  ),
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

        yield* Effect.addFinalizer(() =>
          Effect.forEach([owned, foreign, unlabelled], removeVolume, { discard: true }),
        );
        yield* createVolume(owned, [
          "com.supabase.stack-managed=true",
          `com.supabase.stack-test-run=${runId}`,
        ]);
        yield* createVolume(foreign, [
          "com.supabase.stack-managed=true",
          `com.supabase.stack-test-run=${otherRunId}`,
        ]);
        yield* createVolume(unlabelled, ["com.supabase.stack-managed=true"]);
        expect(yield* volumeExists(owned)).toBe(true);

        yield* removeTestRunVolumes(runId);

        expect(yield* volumeExists(owned)).toBe(false);
        expect(yield* volumeExists(foreign)).toBe(true);
        expect(yield* volumeExists(unlabelled)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
