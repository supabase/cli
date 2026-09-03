import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { legacyConfigFileHasUncommittedChanges } from "./legacy-git-status.ts";

/** Matches the standing `mockSpawner` shape in `legacy-container-cli.unit.test.ts`. */
function mockSpawner(
  opts: {
    readonly spawnFails?: boolean;
    readonly exitCode?: number;
    readonly stdout?: string;
  } = {},
) {
  const spawned: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string | undefined;
  }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const cmd = command._tag === "StandardCommand" ? command.command : "";
      const args = command._tag === "StandardCommand" ? command.args : [];
      const cwd = command._tag === "StandardCommand" ? command.options.cwd : undefined;
      spawned.push({ command: cmd, args, cwd });

      if (opts.spawnFails === true) {
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

describe("legacyConfigFileHasUncommittedChanges", () => {
  it.live("reports dirty when git status --porcelain reports non-empty output", () => {
    const mock = mockSpawner({ stdout: " M config.toml\n" });
    return legacyConfigFileHasUncommittedChanges("/repo/supabase/config.toml").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
      Effect.map((result) => {
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) expect(result.value).toBe(true);
      }),
    );
  });

  it.live("reports clean when git status --porcelain exits 0 with empty output", () => {
    const mock = mockSpawner({ stdout: "" });
    return legacyConfigFileHasUncommittedChanges("/repo/supabase/config.toml").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
      Effect.map((result) => {
        expect(Option.isSome(result)).toBe(true);
        if (Option.isSome(result)) expect(result.value).toBe(false);
      }),
    );
  });

  it.live("degrades to none when git status exits non-zero (e.g. outside a work tree)", () => {
    const mock = mockSpawner({ exitCode: 128, stdout: "" });
    return legacyConfigFileHasUncommittedChanges("/repo/supabase/config.toml").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
      Effect.map((result) => {
        expect(Option.isNone(result)).toBe(true);
      }),
    );
  });

  it.live("degrades to none when git cannot be spawned", () => {
    const mock = mockSpawner({ spawnFails: true });
    return legacyConfigFileHasUncommittedChanges("/repo/supabase/config.toml").pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
      Effect.map((result) => {
        expect(Option.isNone(result)).toBe(true);
      }),
    );
  });

  it.live(
    "runs `git status --porcelain -- <basename>` with cwd set to the file's directory",
    () => {
      const mock = mockSpawner({ stdout: "" });
      return legacyConfigFileHasUncommittedChanges("/repo/supabase/config.toml").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
        Effect.map(() => {
          expect(mock.spawned).toEqual([
            {
              command: "git",
              args: ["status", "--porcelain", "--", "config.toml"],
              cwd: "/repo/supabase",
            },
          ]);
        }),
      );
    },
  );
});
