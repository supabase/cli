import { BunServices } from "@effect/platform-bun";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { Data, Deferred, Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { HealthCheckTimeoutError } from "./health-check.ts";
import { isUnhealthyStartError, rollbackDatabaseStart, rollbackStart } from "./rollback.ts";

function captureStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

interface SpawnResult {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/**
 * Every spawned command answers with the same fixed `exitCode`/`stdout`/`stderr`, enough to
 * drive `dockerRemoveAll` through either its success path or its first failure branch.
 * `respond` answers per command instead.
 */
function mockSpawner(
  opts: SpawnResult & { readonly respond?: (args: ReadonlyArray<string>) => SpawnResult } = {},
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = opts.respond?.(args) ?? opts;

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode ?? 0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(
          result.stdout !== undefined ? [encoder.encode(result.stdout)] : [],
        ),
        stderr: Stream.fromIterable(
          result.stderr !== undefined ? [encoder.encode(result.stderr)] : [],
        ),
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
      ).pipe(Effect.provide(BunServices.layer));
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith("Stopping containers...\n");
      expect(mock.spawned.map((args) => args[0])).toEqual(["ps", "container", "network"]);
    }).pipe(Effect.provide(BunServices.layer));
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
      ).pipe(Effect.provide(BunServices.layer));
      expect(mock.spawned.map((args) => args[0])).toEqual([
        "ps",
        "container",
        "version",
        "volume",
        "network",
      ]);
    }).pipe(Effect.provide(BunServices.layer));
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
      ).pipe(Effect.provide(BunServices.layer));
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenNthCalledWith(1, "Stopping containers...\n");
      expect(stderr).toHaveBeenNthCalledWith(2, "failed to list containers: permission denied\n");
    }).pipe(Effect.provide(BunServices.layer));
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
      ).pipe(Effect.provide(BunServices.layer));
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenNthCalledWith(1, "Stopping containers...\n");
      expect(stderr).toHaveBeenNthCalledWith(2, "failed to list containers\n");
    }).pipe(Effect.provide(BunServices.layer));
  });
});

describe("rollbackDatabaseStart", () => {
  const FILTER = "com.supabase.cli.project=my-app";
  const DB = "supabase_db_my-app";
  const removeDb = ["container", "rm", "-f", DB];
  const removeDbVolume = ["volume", "rm", "-f", DB];
  const pruneNetworks = ["network", "prune", "--force", "--filter", `label=${FILTER}`];

  it.live("removes only the db container, then prunes the project's networks", () => {
    const mock = mockSpawner();
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* rollbackDatabaseStart(mock.spawner, FILTER, DB, false, false);
      expect(mock.spawned).toEqual([removeDb, pruneNetworks]);
      expect(stderr.mock.calls).toEqual([["Stopping containers...\n"]]);
    });
  });

  it.live("also removes the db volume, after the container, when the volume is fresh", () => {
    const mock = mockSpawner();
    captureStderr();
    return Effect.gen(function* () {
      yield* rollbackDatabaseStart(mock.spawner, FILTER, DB, true, false);
      expect(mock.spawned).toEqual([removeDb, removeDbVolume, pruneNetworks]);
    });
  });

  it.live("reports the pruned networks to stderr in debug mode", () => {
    const mock = mockSpawner({
      respond: (args) =>
        args[0] === "network" ? { stdout: "Deleted Networks:\nsupabase_network_my-app\n" } : {},
    });
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* rollbackDatabaseStart(mock.spawner, FILTER, DB, false, true);
      expect(stderr.mock.calls).toEqual([
        ["Stopping containers...\n"],
        ["Pruned network: [supabase_network_my-app]\n"],
      ]);
    });
  });

  const removalOutcomes = [
    {
      scenario: "a missing container",
      failing: "container rm",
      stderr: `Error response from daemon: No such container: ${DB}`,
      logged: undefined,
    },
    {
      scenario: "a missing container reported by Podman",
      failing: "container rm",
      stderr: `Error: no container with name or ID "${DB}" found: no such container`,
      logged: undefined,
    },
    {
      scenario: "a missing volume",
      failing: "volume rm",
      stderr: `Error response from daemon: No such volume: ${DB}`,
      logged: undefined,
    },
    {
      scenario: "a container that cannot be removed",
      failing: "container rm",
      stderr: "permission denied",
      logged: "failed to remove container: permission denied",
    },
    {
      scenario: "a volume that cannot be removed",
      failing: "volume rm",
      stderr: `Error response from daemon: remove ${DB}: volume is in use`,
      logged: `failed to remove volume: Error response from daemon: remove ${DB}: volume is in use`,
    },
    {
      scenario: "networks that cannot be pruned",
      failing: "network prune",
      stderr: "permission denied",
      logged: "failed to prune networks: permission denied",
    },
  ] as const;
  for (const { scenario, failing, stderr: failureStderr, logged } of removalOutcomes) {
    it.live(
      `${logged === undefined ? "silently continues" : "logs the failure and continues"} past ${scenario}`,
      () => {
        const mock = mockSpawner({
          respond: (args) =>
            args.slice(0, 2).join(" ") === failing ? { exitCode: 1, stderr: failureStderr } : {},
        });
        const stderr = captureStderr();
        return Effect.gen(function* () {
          yield* rollbackDatabaseStart(mock.spawner, FILTER, DB, true, false);
          expect(mock.spawned).toEqual([removeDb, removeDbVolume, pruneNetworks]);
          expect(stderr.mock.calls).toEqual([
            ["Stopping containers...\n"],
            ...(logged === undefined ? [] : [[`${logged}\n`]]),
          ]);
        });
      },
    );
  }

  it.live("never fails when no container runtime can be spawned", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn ENOENT",
        }),
      ),
    );
    const stderr = captureStderr();
    return Effect.gen(function* () {
      yield* rollbackDatabaseStart(spawner, FILTER, DB, true, false);
      expect(stderr.mock.calls.map(([line]) => line)).toEqual([
        "Stopping containers...\n",
        expect.stringContaining("failed to remove container"),
        expect.stringContaining("failed to remove volume"),
        expect.stringContaining("failed to prune networks"),
      ]);
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
