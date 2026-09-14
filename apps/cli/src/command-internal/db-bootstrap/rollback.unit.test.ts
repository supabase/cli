import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Data, Deferred, Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { HealthCheckTimeoutError } from "./health-check.ts";
import { isUnhealthyStartError, rollbackStart } from "./rollback.ts";

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every spawned command answers with the same fixed `exitCode`/`stdout`/`stderr`, enough to
 * drive `dockerRemoveAll` through either its success path or its first failure branch.
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

describe("rollbackStart", () => {
  it.live("tears down every container/volume/network by project label on success", () => {
    const mock = mockSpawner({ exitCode: 0, stdout: "" });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* rollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/rollback-unit-test-workdir",
        false,
      );
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("Stopping containers...\n");
      expect(mock.spawned.map((args) => args[0])).toEqual(["ps", "container", "network"]);
    });
  });

  it.live("requests a volume prune when deleteVolumes is true", () => {
    const mock = mockSpawner({ exitCode: 0, stdout: "" });
    return Effect.gen(function* () {
      yield* rollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        true,
        "/tmp/rollback-unit-test-workdir",
        false,
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
      yield* rollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/rollback-unit-test-workdir",
        false,
      );
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenNthCalledWith(1, "Stopping containers...\n");
      expect(stderr).toHaveBeenNthCalledWith(2, "failed to list containers: permission denied\n");
    });
  });

  it.live("logs a generic message to stderr when the underlying failure has no stderr text", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* rollbackStart(
        mock.spawner,
        "com.supabase.cli.project=my-app",
        false,
        "/tmp/rollback-unit-test-workdir",
        false,
      );
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenNthCalledWith(1, "Stopping containers...\n");
      expect(stderr).toHaveBeenNthCalledWith(2, "failed to list containers\n");
    });
  });
});

class OtherTaggedError extends Data.TaggedError("OtherTaggedError")<{
  readonly message: string;
}> {}

describe("isUnhealthyStartError", () => {
  it("returns true for a HealthCheckTimeoutError", () => {
    const error = new HealthCheckTimeoutError({ message: "timed out", unhealthy: [] });
    expect(isUnhealthyStartError(error)).toBe(true);
  });

  it("returns false for an unrelated tagged error", () => {
    const error = new OtherTaggedError({ message: "boom" });
    expect(isUnhealthyStartError(error)).toBe(false);
  });

  it("returns false for a plain Error, string, or nullish value", () => {
    expect(isUnhealthyStartError(new Error("boom"))).toBe(false);
    expect(isUnhealthyStartError("boom")).toBe(false);
    expect(isUnhealthyStartError(undefined)).toBe(false);
    expect(isUnhealthyStartError(null)).toBe(false);
  });
});
