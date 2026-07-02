import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  containerCliExitCode,
  legacyDescribeContainerCliFailure,
  spawnContainerCli,
} from "./legacy-container-cli.ts";

function mockSpawner(
  opts: {
    readonly dockerMissing?: boolean;
    readonly bothMissing?: boolean;
    readonly exitCode?: number;
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
        stdout: Stream.empty,
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
          "docker: command not found (podman also not found) — install Docker Desktop or Podman and ensure it is on PATH",
        );
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
        expect(legacyDescribeContainerCliFailure(error)).toContain("docker: command not found");
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
