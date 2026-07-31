import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Data, Deferred, Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { LegacyHealthCheckTimeoutError } from "./health-check.ts";
import { legacyIsUnhealthyStartError, legacyRollbackStart } from "./rollback.ts";

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Mirrors `legacy-docker-lifecycle.unit.test.ts`'s `mockSpawner`: every
 * command spawned (list/stop/prune) answers with the same fixed
 * `exitCode`/`stdout`/`stderr`, which is enough to drive
 * `legacyDockerRemoveAll` through either its success path (empty container
 * list, every prune exits 0) or its very first failure branch (a non-zero
 * `docker ps` exit).
 */
function mockSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode ?? 0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(opts.stdout !== undefined ? [encoder.encode(opts.stdout)] : []),
        stderr: Stream.fromIterable(opts.stderr !== undefined ? [encoder.encode(opts.stderr)] : []),
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    get spawned() {
      return spawned;
    },
  };
}

describe("legacyRollbackStart", () => {
  it.live("tears down every container/volume/network by project label on success", () => {
    const mock = mockSpawner({ exitCode: 0, stdout: "" });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* legacyRollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/legacy-rollback-unit-test-workdir",
      );
      expect(stderr).not.toHaveBeenCalled();
      // legacyDockerRemoveAll's own list (its `onContainersListed` hook feeds
      // legacyCleanupStartSecrets the same container names, no second `ps`
      // call) -> container prune -> network prune; no stop calls (empty list)
      // and no volume prune (deleteVolumes: false).
      expect(mock.spawned.map((args) => args[0])).toEqual(["ps", "container", "network"]);
    });
  });

  it.live("requests a volume prune when deleteVolumes is true", () => {
    const mock = mockSpawner({ exitCode: 0, stdout: "" });
    return Effect.gen(function* () {
      yield* legacyRollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        true,
        "/tmp/legacy-rollback-unit-test-workdir",
      );
      expect(mock.spawned.map((args) => args[0])).toEqual([
        "ps",
        "container",
        "version",
        "volume",
        "network",
      ]);
    });
  });

  it.live("swallows a rollback failure, logging it to stderr instead of failing the effect", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "permission denied" });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      // Never fails — Effect.Effect<void, never> — a rollback failure is
      // logged, never propagated (Go's `fmt.Fprintln(os.Stderr, err)` swallow).
      yield* legacyRollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/legacy-rollback-unit-test-workdir",
      );
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("failed to list containers: permission denied\n");
    });
  });

  it.live("logs a generic message to stderr when the underlying failure has no stderr text", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* legacyRollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/legacy-rollback-unit-test-workdir",
      );
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("failed to list containers\n");
    });
  });
});

class LegacyOtherTaggedError extends Data.TaggedError("LegacyOtherTaggedError")<{
  readonly message: string;
}> {}

describe("legacyIsUnhealthyStartError", () => {
  it("returns true for a LegacyHealthCheckTimeoutError", () => {
    const error = new LegacyHealthCheckTimeoutError({ message: "timed out", unhealthy: [] });
    expect(legacyIsUnhealthyStartError(error)).toBe(true);
  });

  it("returns false for an unrelated tagged error", () => {
    const error = new LegacyOtherTaggedError({ message: "boom" });
    expect(legacyIsUnhealthyStartError(error)).toBe(false);
  });

  it("returns false for a plain Error, string, or nullish value", () => {
    expect(legacyIsUnhealthyStartError(new Error("boom"))).toBe(false);
    expect(legacyIsUnhealthyStartError("boom")).toBe(false);
    expect(legacyIsUnhealthyStartError(undefined)).toBe(false);
    expect(legacyIsUnhealthyStartError(null)).toBe(false);
  });
});
