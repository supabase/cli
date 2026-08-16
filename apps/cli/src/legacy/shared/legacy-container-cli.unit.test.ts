import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  containerCliExitCode,
  legacyChildResult,
  legacyContainerRuntimeNotFoundMessage,
  legacyDescribeContainerCliFailure,
  legacyDockerSupportsVolumePruneAllFlag,
  legacyGateOnExitCode,
  legacyIsContainerNotFoundMessage,
  spawnContainerCli,
} from "./legacy-container-cli.ts";

function mockSpawner(
  opts: {
    readonly dockerMissing?: boolean;
    readonly bothMissing?: boolean;
    readonly exitCode?: number;
    readonly stdout?: string;
  } = {},
) {
  const spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const cmd = command._tag === "StandardCommand" ? command.command : "";
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push({ command: cmd, args });

      if ((opts.dockerMissing && cmd === "docker") || opts.bothMissing === true) {
        return yield* Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: `${cmd} not found`,
          }),
        );
      }

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode ?? 0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout:
          opts.stdout !== undefined
            ? Stream.fromIterable([new TextEncoder().encode(opts.stdout)])
            : Stream.empty,
        stderr: Stream.empty,
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

describe("spawnContainerCli", () => {
  it.live("spawns docker and does not touch podman when docker is available", () => {
    const mock = mockSpawner();
    return spawnContainerCli(mock.spawner, ["pull", "supabase/postgres:17"]).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          { command: "docker", args: ["pull", "supabase/postgres:17"] },
        ]);
      }),
    );
  });

  it.live("falls back to podman when the docker executable cannot be spawned", () => {
    const mock = mockSpawner({ dockerMissing: true });
    return spawnContainerCli(mock.spawner, ["pull", "supabase/postgres:17"]).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          { command: "docker", args: ["pull", "supabase/postgres:17"] },
          { command: "podman", args: ["pull", "supabase/postgres:17"] },
        ]);
      }),
    );
  });
});

/** A bare handle whose exit code resolves immediately with configurable stdio streams. */
function makeTestHandle(opts: {
  readonly exitCode: number;
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
}) {
  return Effect.gen(function* () {
    const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      stdout: opts.stdout ?? Stream.empty,
      stderr: opts.stderr ?? Stream.empty,
      all: Stream.empty,
      exitCode: Deferred.await(exitDeferred),
      isRunning: Effect.succeed(false),
      stdin: Sink.drain,
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  });
}

const encoded = (text: string) => new TextEncoder().encode(text);

describe("legacyChildResult", () => {
  it.live("collects both streams to completion when they end normally", () =>
    Effect.gen(function* () {
      const handle = yield* makeTestHandle({
        exitCode: 0,
        stdout: Stream.make(encoded("payload")),
        stderr: Stream.make(encoded("warning")),
      });
      const result = yield* legacyChildResult(handle, { stdout: true, stderr: true });
      expect(result).toEqual({ exitCode: 0, stdout: "payload", stderr: "warning" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "returns within the bounded grace with partial text when a stream never reaches EOF",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeTestHandle({
          exitCode: 1,
          stderr: Stream.concat(Stream.make(encoded("No such container")), Stream.never),
        });
        const result = yield* legacyChildResult(handle, { stderr: true });
        expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "No such container" });
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live(
    "collects output that arrives after the exit code has already resolved",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeTestHandle({
          exitCode: 1,
          stderr: Stream.concat(
            Stream.fromEffect(Effect.as(Effect.sleep("150 millis"), encoded("late error"))),
            Stream.never,
          ),
        });
        const result = yield* legacyChildResult(handle, { stderr: true });
        expect(result.stderr).toBe("late error");
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live("leaves uncollected streams empty", () =>
    Effect.gen(function* () {
      const handle = yield* makeTestHandle({
        exitCode: 0,
        stdout: Stream.make(encoded("ignored")),
      });
      const result = yield* legacyChildResult(handle, { stderr: true });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }).pipe(Effect.scoped),
  );

  it.live(
    "keeps draining output that continues to flow long past the idle window",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeTestHandle({
          exitCode: 0,
          stdout: Stream.fromIterable(Array.from({ length: 15 }, () => encoded("x"))).pipe(
            Stream.mapEffect((chunk) => Effect.as(Effect.sleep("150 millis"), chunk)),
          ),
        });
        const result = yield* legacyChildResult(handle, { stdout: true });
        expect(result.stdout).toBe("x".repeat(15));
      }).pipe(Effect.scoped),
    10_000,
  );
});

describe("legacyGateOnExitCode", () => {
  it.live(
    "kills the child and returns when a drain fails while it is still running",
    () =>
      Effect.gen(function* () {
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.never,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(true),
          stdin: Sink.drain,
          kill: () =>
            Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(137)).pipe(Effect.asVoid),
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        const { exitCode } = yield* legacyGateOnExitCode(
          handle,
          [Effect.fail(new Error("sink failed"))],
          () => 0,
        );
        expect(exitCode).toBe(137);
      }).pipe(Effect.scoped),
    10_000,
  );
});

describe("containerCliExitCode", () => {
  it.live("resolves docker's exit code without trying podman when docker runs", () => {
    const mock = mockSpawner({ exitCode: 0 });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.map((exitCode) => {
        expect(exitCode).toBe(0);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker"]);
      }),
    );
  });

  it.live("falls back to podman's exit code when the docker executable is missing", () => {
    const mock = mockSpawner({ dockerMissing: true, exitCode: 1 });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.map((exitCode) => {
        expect(exitCode).toBe(1);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker", "podman"]);
      }),
    );
  });

  it.live("fails with a clear message when neither docker nor podman can be spawned", () => {
    const mock = mockSpawner({ bothMissing: true });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(legacyDescribeContainerCliFailure(error)).toBe(
          legacyContainerRuntimeNotFoundMessage,
        );
      }),
    );
  });
});

describe("legacyDockerSupportsVolumePruneAllFlag", () => {
  it.live("returns true when the daemon reports an API version at or above 1.42", () => {
    const mock = mockSpawner({ stdout: "1.42" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(true);
        expect(mock.spawned).toEqual([
          { command: "docker", args: ["version", "--format", "{{.Server.APIVersion}}"] },
        ]);
      }),
    );
  });

  it.live("returns true for a version comfortably above 1.42", () => {
    const mock = mockSpawner({ stdout: "1.51" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(true);
      }),
    );
  });

  it.live("returns false when the daemon reports an API version below 1.42", () => {
    const mock = mockSpawner({ stdout: "1.41" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("compares version components numerically, not lexicographically", () => {
    // A naive string compare would misorder "1.9" as greater than "1.42" — this
    // guards the numeric, component-by-component comparison instead.
    const mock = mockSpawner({ stdout: "1.9" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("returns false when the version command exits non-zero", () => {
    const mock = mockSpawner({ exitCode: 1, stdout: "1.51" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("returns false when the reported version is empty", () => {
    const mock = mockSpawner({ stdout: "" });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("returns false without falling back to podman when docker cannot be spawned", () => {
    const mock = mockSpawner({ dockerMissing: true });
    return legacyDockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker"]);
      }),
    );
  });
});

describe("legacyDescribeContainerCliFailure", () => {
  it.live("describes a both-runtimes-missing failure with its clear message", () => {
    const mock = mockSpawner({ bothMissing: true });
    return containerCliExitCode(mock.spawner, ["ps"]).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(legacyDescribeContainerCliFailure(error)).toContain(
          legacyContainerRuntimeNotFoundMessage,
        );
      }),
    );
  });

  it("falls back to an Error instance's own message", () => {
    expect(legacyDescribeContainerCliFailure(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error cause", () => {
    expect(legacyDescribeContainerCliFailure("boom")).toBe("boom");
    expect(legacyDescribeContainerCliFailure(42)).toBe("42");
  });
});

describe("legacyIsContainerNotFoundMessage", () => {
  it("recognizes Docker's uppercase shapes", () => {
    expect(legacyIsContainerNotFoundMessage("Error: No such container: db")).toBe(true);
    expect(legacyIsContainerNotFoundMessage("Error: No such object: db")).toBe(true);
  });

  it("recognizes Podman's lowercase shapes, case-insensitively", () => {
    expect(legacyIsContainerNotFoundMessage("error: no such container db")).toBe(true);
    expect(legacyIsContainerNotFoundMessage("Error: no such object: db")).toBe(true);
  });

  it("recognizes Podman's 'no container with name or ID' shape", () => {
    expect(
      legacyIsContainerNotFoundMessage(
        'no container with name or ID "db" found: no such container',
      ),
    ).toBe(true);
    expect(legacyIsContainerNotFoundMessage("No container with name or ID db found")).toBe(true);
  });

  it("rejects unrelated failures", () => {
    expect(legacyIsContainerNotFoundMessage("Cannot connect to the Docker daemon")).toBe(false);
  });
});
