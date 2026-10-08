import { randomUUID } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  testRunEnvVar as stackTestRunEnvVar,
  testRunLabelKey,
} from "../src/internal/test-run-label.ts";
import { runEngine } from "./docker-fixture.ts";

/**
 * Docker test state roots must be private to a run (see `makeDockerDatabaseRoot` and
 * `Commands.integration.test.ts`'s Docker variants): a shared root's volume would be labelled
 * by whichever run first creates it, and a later run sharing that root could have its data
 * removed by this cleanup. The `@supabase/stack/testing` default shared root is outside this
 * cleanup and must not be used for Docker-backed tests.
 */
export { stackTestRunEnvVar };

const managedFilter = "label=com.supabase.stack-managed=true";
const testRunFilter = (id: string) => `label=${testRunLabelKey}=${id}`;

/** One owned test run's marker: the host process that must still be alive for the run to own it. */
const RunMarker = Schema.Struct({ pid: Schema.Int, startedAt: Schema.String });
export type RunMarker = Schema.Schema.Type<typeof RunMarker>;
export const encodeRunMarker = Schema.encodeEffect(Schema.fromJsonString(RunMarker));
const decodeRunMarker = Schema.decodeEffect(Schema.fromJsonString(RunMarker));

/** Per-user, host-local directory holding one marker file per test run this host has started. */
export const markerDirectory = (path: Path.Path): string =>
  path.join(tmpdir(), `supabase-stack-test-runs-${userInfo().uid}`);

/** The marker file path for one test run's id, exported so recovery tests can seed fixtures. */
export const markerFile = (path: Path.Path, id: string): string =>
  path.join(markerDirectory(path), `${id}.json`);

/** True when `pid` is a dead process; an unauthorized signal still proves it is alive. */
const isDead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
};

const dockerUnavailable = runEngine(["version"]).pipe(
  Effect.map((result) => result.code !== 0),
  Effect.catchCause(() => Effect.succeed(true)),
);

/**
 * Removes exactly the stack-managed Docker volumes labelled with this test run's id. Prints one
 * note and does nothing when Docker is missing or its daemon is unreachable.
 */
export const removeTestRunVolumes = Effect.fn("DockerVolumeRun.removeTestRunVolumes")(
  (id: string) =>
    Effect.gen(function* () {
      if (yield* dockerUnavailable) {
        yield* Effect.logWarning(
          "[docker-volume-run] Skipping test-run Docker volume cleanup: Docker is missing or its daemon is unreachable.",
        );
        return;
      }
      const listed = yield* runEngine([
        "volume",
        "ls",
        "-q",
        "--filter",
        managedFilter,
        "--filter",
        testRunFilter(id),
      ]);
      if (listed.code !== 0)
        return yield* Effect.die(`docker volume ls failed: ${listed.output.trim()}`);
      const volumes = listed.output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (volumes.length === 0) return;
      const removals = yield* Effect.forEach(volumes, (volume) =>
        runEngine(["volume", "rm", volume]).pipe(Effect.map((result) => ({ volume, result }))),
      );
      const failed = removals.filter(({ result }) => result.code !== 0);
      if (failed.length > 0)
        return yield* Effect.die(
          `Failed to remove test-run Docker volumes: ${failed
            .map(({ volume, result }) => `${volume} (${result.output.trim()})`)
            .join(", ")}`,
        );
    }),
);

// A benign "not found" tolerates a concurrent setup recovering the same dead run first.
const benign = (output: string) => /no such (?:container|volume)/iu.test(output);

/** Removes a dead run's labelled containers; `Option.none` on success, a message otherwise. */
const removeDeadRunContainers = Effect.fn("DockerVolumeRun.removeDeadRunContainers")((id: string) =>
  Effect.gen(function* () {
    const listed = yield* runEngine([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      testRunFilter(id),
    ]);
    if (listed.code !== 0) return Option.some(`docker ps failed: ${listed.output.trim()}`);
    const ids = listed.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (ids.length === 0) return Option.none<string>();
    const removed = yield* runEngine(["rm", "--force", "--volumes", ...ids]);
    return removed.code === 0 || benign(removed.output)
      ? Option.none<string>()
      : Option.some(`docker rm failed: ${removed.output.trim()}`);
  }),
);

/** Removes a dead run's labelled, stack-managed volumes; `Option.none` on success. */
const removeDeadRunVolumes = Effect.fn("DockerVolumeRun.removeDeadRunVolumes")((id: string) =>
  Effect.gen(function* () {
    const listed = yield* runEngine([
      "volume",
      "ls",
      "-q",
      "--filter",
      managedFilter,
      "--filter",
      testRunFilter(id),
    ]);
    if (listed.code !== 0) return Option.some(`docker volume ls failed: ${listed.output.trim()}`);
    const volumes = listed.output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (volumes.length === 0) return Option.none<string>();
    const removals = yield* Effect.forEach(volumes, (volume) =>
      runEngine(["volume", "rm", volume]).pipe(Effect.map((result) => ({ volume, result }))),
    );
    const failed = removals.filter(({ result }) => result.code !== 0 && !benign(result.output));
    return failed.length === 0
      ? Option.none<string>()
      : Option.some(
          `docker volume rm failed: ${failed
            .map(({ volume, result }) => `${volume} (${result.output.trim()})`)
            .join(", ")}`,
        );
  }),
);

/**
 * Removes one dead run's labelled containers then volumes, deleting its marker only when both
 * succeed or find nothing. A failure keeps the marker for the next recovery and logs one warning;
 * it never fails the run that triggered recovery.
 */
const recoverDeadRun = Effect.fn("DockerVolumeRun.recoverDeadRun")(
  (path: Path.Path, fs: FileSystem.FileSystem, id: string) =>
    Effect.gen(function* () {
      const containerFailure = yield* removeDeadRunContainers(id);
      const volumeFailure = yield* removeDeadRunVolumes(id);
      const failures = [containerFailure, volumeFailure].filter(Option.isSome).map((o) => o.value);
      if (failures.length > 0) {
        yield* Effect.logWarning(
          `[docker-volume-run] Leaving dead test run ${id}'s marker after a failed recovery: ${failures.join("; ")}`,
        );
        return;
      }
      yield* fs.remove(markerFile(path, id), { force: true });
    }),
);

/**
 * Recovers Docker resources left by test runs whose process died without running teardown (for
 * example a SIGKILL, or Bun's vitest exiting on SIGINT/SIGTERM without running globalSetup
 * teardown). Only a run whose marked pid is dead is touched; a live run, including a concurrent
 * one, is left alone. Does nothing, keeping every marker, when Docker is unreachable.
 */
export const recoverDeadRuns = Effect.fn("DockerVolumeRun.recoverDeadRuns")(() =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = markerDirectory(path);
    yield* fs.makeDirectory(directory, { recursive: true });
    if (yield* dockerUnavailable) {
      yield* Effect.logWarning(
        "[docker-volume-run] Skipping dead test-run recovery: Docker is missing or its daemon is unreachable.",
      );
      return;
    }
    const entries = yield* fs.readDirectory(directory);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const marker = yield* fs
        .readFileString(path.join(directory, entry))
        .pipe(Effect.flatMap(decodeRunMarker), Effect.option);
      if (Option.isNone(marker) || !isDead(marker.value.pid)) continue;
      yield* recoverDeadRun(path, fs, id);
    }
  }),
);

/** Writes this run's marker so a later setup can recover its resources if it dies uncleanly. */
const writeOwnMarker = Effect.fn("DockerVolumeRun.writeOwnMarker")((id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const marker: RunMarker = {
      pid: process.pid,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* fs.writeFileString(markerFile(path, id), yield* encodeRunMarker(marker), {
      mode: 0o600,
    });
  }),
);

const deleteOwnMarker = Effect.fn("DockerVolumeRun.deleteOwnMarker")((id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.remove(markerFile(path, id), { force: true });
  }),
);

/**
 * Vitest `globalSetup`, wired into the integration and e2e projects of both `packages/stack` and
 * `apps/cli`. Generates one random id for this invocation and removes the Docker volumes it
 * labels when the run ends, unless an outer invocation already owns
 * `SUPABASE_STACK_TEST_RUN`: the root `vitest.config.ts` aggregates every package's projects, so
 * several project setups can run in one invocation, and only the outermost one should own
 * cleanup. The outermost setup also recovers resources left by earlier runs that died without
 * running this teardown.
 */
// oxlint-disable-next-line effecttsgo/async-function -- Vitest's globalSetup API requires a Promise-returning function; this is the non-Effect consumer boundary.
export async function setup(): Promise<(() => Promise<void>) | undefined> {
  // oxlint-disable-next-line effecttsgo/process-env -- see below.
  if (process.env[stackTestRunEnvVar] !== undefined) return undefined;
  const id = randomUUID();
  // oxlint-disable-next-line effecttsgo/process-env -- must be a real process.env value so vitest workers and spawned CLI subprocesses inherit it.
  process.env[stackTestRunEnvVar] = id;
  await Effect.runPromise(
    recoverDeadRuns().pipe(Effect.andThen(writeOwnMarker(id)), Effect.provide(NodeServices.layer)),
  );
  // oxlint-disable-next-line effecttsgo/async-function -- the returned teardown is Vitest's globalSetup contract, not application logic.
  return async () => {
    try {
      await Effect.runPromise(
        removeTestRunVolumes(id).pipe(
          Effect.andThen(deleteOwnMarker(id)),
          Effect.provide(NodeServices.layer),
        ),
      );
    } finally {
      // oxlint-disable-next-line effecttsgo/process-env -- releases ownership so a later setup in this process owns its own run.
      if (process.env[stackTestRunEnvVar] === id) delete process.env[stackTestRunEnvVar];
    }
  };
}

export default setup;
