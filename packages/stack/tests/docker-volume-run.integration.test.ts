import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, DateTime, Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runDocker } from "./docker-fixture.ts";
import {
  encodeRunMarker,
  markerDirectory,
  markerFile,
  recoverDeadRuns,
  removeTestRunVolumes,
} from "./docker-volume-run.ts";

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

const containerExists = Effect.fn("DockerVolumeRunTest.containerExists")((name: string) =>
  runDocker(["inspect", name]).pipe(Effect.map((result) => result.code === 0)),
);

const createContainer = Effect.fn("DockerVolumeRunTest.createContainer")(
  (name: string, labels: ReadonlyArray<string>) =>
    runDocker([
      "create",
      "--name",
      name,
      ...labels.flatMap((label) => ["--label", label]),
      "busybox:1.36",
      "true",
    ]).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.void
          : Effect.die(`docker create ${name} failed: ${result.output}`),
      ),
    ),
);

const removeContainer = Effect.fn("DockerVolumeRunTest.removeContainer")((name: string) =>
  runDocker(["rm", "--force", "--volumes", name]).pipe(
    Effect.flatMap((result) =>
      result.code === 0 || /no such container/iu.test(result.output)
        ? Effect.void
        : Effect.die(`docker rm ${name} failed: ${result.output}`),
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

describe("dead test-run recovery", { timeout: 120_000 }, () => {
  it.live(
    "removes a dead run's labelled container and volume, leaving a live run's and an unlabelled one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const crypto = yield* Crypto.Crypto;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const suffix = (yield* crypto.randomUUIDv4).slice(0, 8);
          const deadRunId = `recovery-dead-${suffix}`;
          const liveRunId = `recovery-live-${suffix}`;
          const deadVolume = `sb-recovery-dead-volume-${suffix}`;
          const liveVolume = `sb-recovery-live-volume-${suffix}`;
          const unlabelledVolume = `sb-recovery-unlabelled-volume-${suffix}`;
          const deadContainer = `sb-recovery-dead-container-${suffix}`;
          const liveContainer = `sb-recovery-live-container-${suffix}`;
          const unlabelledContainer = `sb-recovery-unlabelled-container-${suffix}`;
          const deadMarker = markerFile(path, deadRunId);
          const liveMarker = markerFile(path, liveRunId);

          // Guaranteed dead once awaited: a process that has already exited cannot be a live pid.
          const dying = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["-e", "process.exit(0)"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          const deadPid = dying.pid;
          yield* dying.exitCode;

          yield* Effect.addFinalizer(() =>
            Effect.forEach([deadVolume, liveVolume, unlabelledVolume], removeVolume, {
              discard: true,
            }).pipe(
              Effect.andThen(
                Effect.forEach(
                  [deadContainer, liveContainer, unlabelledContainer],
                  removeContainer,
                  { discard: true },
                ),
              ),
              Effect.andThen(
                Effect.forEach(
                  [deadMarker, liveMarker],
                  (file) => fs.remove(file, { force: true }).pipe(Effect.orDie),
                  { discard: true },
                ),
              ),
            ),
          );

          yield* createVolume(deadVolume, [
            "com.supabase.stack-managed=true",
            `com.supabase.stack-test-run=${deadRunId}`,
          ]);
          yield* createVolume(liveVolume, [
            "com.supabase.stack-managed=true",
            `com.supabase.stack-test-run=${liveRunId}`,
          ]);
          yield* createVolume(unlabelledVolume, ["com.supabase.stack-managed=true"]);
          yield* createContainer(deadContainer, [`com.supabase.stack-test-run=${deadRunId}`]);
          yield* createContainer(liveContainer, [`com.supabase.stack-test-run=${liveRunId}`]);
          yield* createContainer(unlabelledContainer, []);

          const startedAt = DateTime.formatIso(yield* DateTime.now);
          yield* fs.makeDirectory(markerDirectory(path), { recursive: true });
          yield* fs.writeFileString(
            deadMarker,
            yield* encodeRunMarker({ pid: deadPid, startedAt }),
          );
          yield* fs.writeFileString(
            liveMarker,
            yield* encodeRunMarker({ pid: process.pid, startedAt }),
          );

          yield* recoverDeadRuns();

          expect(yield* volumeExists(deadVolume)).toBe(false);
          expect(yield* containerExists(deadContainer)).toBe(false);
          expect(yield* fs.exists(deadMarker)).toBe(false);

          expect(yield* volumeExists(liveVolume)).toBe(true);
          expect(yield* containerExists(liveContainer)).toBe(true);
          expect(yield* fs.exists(liveMarker)).toBe(true);

          expect(yield* volumeExists(unlabelledVolume)).toBe(true);
          expect(yield* containerExists(unlabelledContainer)).toBe(true);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
