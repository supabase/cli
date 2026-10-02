import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import type { SpawnRequest, SpawnResult } from "@supabase/typegen";
import { Data, Deferred, Effect, FileSystem, Path, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeTypegenHost } from "./types.typegen-host.ts";

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly extendEnv: boolean | undefined;
  readonly shell: boolean | string | undefined;
  stdin: string;
}

/** Records what `spawnForTypegen` asks for and exits like a tool once it has read its stdin. */
function fakeSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly notFound?: boolean;
    /** The tool exits without ever reading its stdin, which stays blocked. */
    readonly stdinBlocked?: boolean;
  } = {},
) {
  const calls: Array<SpawnCall> = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("unexpected command shape");
      }
      const call: SpawnCall = {
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        env: command.options.env,
        extendEnv: command.options.extendEnv,
        shell: command.options.shell,
        stdin: "",
      };
      calls.push(call);
      if (opts.notFound === true) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `${command.command} not found`,
        });
      }
      const stdinRead = yield* Deferred.make<void>();
      const exitCode = ChildProcessSpawner.ExitCode(opts.exitCode ?? 0);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        stdout: Stream.make(encoder.encode(opts.stdout ?? "")),
        stderr: Stream.make(encoder.encode(opts.stderr ?? "")),
        all: Stream.empty,
        exitCode:
          opts.stdinBlocked === true
            ? Effect.succeed(exitCode)
            : Deferred.await(stdinRead).pipe(Effect.as(exitCode)),
        isRunning: Effect.succeed(false),
        stdin:
          opts.stdinBlocked === true
            ? Sink.fromEffect(Effect.never)
            : Sink.forEach((chunk: Uint8Array) =>
                Effect.sync(() => {
                  call.stdin += decoder.decode(chunk, { stream: true });
                }),
              ).pipe(
                Sink.mapEffect(() => Deferred.succeed(stdinRead, undefined).pipe(Effect.asVoid)),
              ),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, calls };
}

const request = (overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  command: "dart",
  args: ["run", "supabase_typegen", "--output", "-"],
  cwd: "/projects/app",
  env: { PATH: "/usr/bin" },
  stdin: '{"version":1}',
  ...overrides,
});

const host = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  platform: NodeJS.Platform = "darwin",
  env: Readonly<Record<string, string | undefined>> = { PATH: "/usr/bin" },
) =>
  makeTypegenHost({
    cwd: "/projects/app",
    env,
    platform,
    spawner,
    runPromise: (effect, options) => Effect.runPromise(effect, options),
  });

describe("makeTypegenHost", () => {
  const spawnOf = (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    platform: NodeJS.Platform = "darwin",
    env: Readonly<Record<string, string | undefined>> = { PATH: "/usr/bin" },
  ) => {
    const { spawn } = host(spawner, platform, env);
    if (spawn === undefined) throw new Error("the typegen host must supply spawn");
    return (req: SpawnRequest) => Effect.promise(() => spawn(req));
  };

  class SpawnRejected extends Data.TaggedError("SpawnRejected")<{ readonly reason: unknown }> {}

  /** The rejection of a spawn, for the contract cases where the promise must fail. */
  const rejectionOf = (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    platform: NodeJS.Platform,
    env: Readonly<Record<string, string | undefined>>,
    req: SpawnRequest,
  ) => {
    const { spawn } = host(spawner, platform, env);
    if (spawn === undefined) throw new Error("the typegen host must supply spawn");
    return Effect.tryPromise({
      try: () => spawn(req),
      catch: (reason) => new SpawnRejected({ reason }),
    }).pipe(Effect.flip);
  };

  it.effect("returns what the tool wrote and feeds it the document on stdin", () =>
    Effect.gen(function* () {
      const { spawner, calls } = fakeSpawner({
        stdout: "class Tickets {}\n",
        stderr: "summary\n",
      });
      const result: SpawnResult = yield* spawnOf(spawner)(request());

      expect(result).toEqual({ exitCode: 0, stdout: "class Tickets {}\n", stderr: "summary\n" });
      expect(calls[0]?.stdin).toBe('{"version":1}');
    }),
  );

  it.effect("returns once a tool exits without reading its stdin", () =>
    Effect.gen(function* () {
      const { spawner } = fakeSpawner({ stdinBlocked: true, exitCode: 3, stderr: "usage\n" });
      const result: SpawnResult = yield* spawnOf(spawner)(request());

      expect(result).toEqual({ exitCode: 3, stdout: "", stderr: "usage\n" });
    }),
  );

  it.effect("reports a non-zero exit as a result rather than a failure", () =>
    Effect.gen(function* () {
      const { spawner } = fakeSpawner({ exitCode: 65, stderr: "Could not parse the document\n" });
      const result = yield* spawnOf(spawner)(request());
      expect(result.exitCode).toBe(65);
      expect(result.stderr).toBe("Could not parse the document\n");
    }),
  );

  it.effect("rejects a missing executable with ENOENT, as the registry's Host contract asks", () =>
    Effect.gen(function* () {
      const { spawner } = fakeSpawner({ notFound: true });
      const error = yield* rejectionOf(spawner, "darwin", { PATH: "/usr/bin" }, request());
      expect(error.reason).toMatchObject({ code: "ENOENT" });
    }),
  );

  it.effect("hands TypeScript back unformatted", () =>
    Effect.gen(function* () {
      const { spawner } = fakeSpawner();
      const { format } = host(spawner);
      if (format === undefined) throw new Error("the typegen host must supply format");
      const code = "export type Database = {}";
      expect(yield* Effect.promise(() => format(code, "output.ts"))).toBe(code);
    }),
  );

  it.effect("on Windows, rejects with ENOENT without spawning when PATH holds no candidate", () =>
    Effect.gen(function* () {
      const { spawner, calls } = fakeSpawner();
      const env = { PATH: "C:\\nowhere", PATHEXT: ".EXE;.BAT" };
      const error = yield* rejectionOf(spawner, "win32", env, request({ env }));
      expect(error.reason).toMatchObject({ code: "ENOENT" });
      expect(calls).toEqual([]);
    }),
  );

  // The registry's lookup joins Windows paths, which only exist on a Windows filesystem.
  describe.skipIf(process.platform !== "win32")("on a Windows filesystem", () => {
    it.effect("runs a .bat found through PATH and PATHEXT through the command interpreter", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "typegen-host-" }),
        );
        const flutter = path.join(dir, "flutter");
        yield* fs.makeDirectory(flutter);
        yield* fs.writeFileString(path.join(flutter, "dart.BAT"), "@echo off\r\n");

        const { spawner, calls } = fakeSpawner({ stdout: "ok" });
        const env = { PATH: flutter, PATHEXT: ".EXE;.BAT" };
        yield* spawnOf(spawner, "win32", env)(request({ env }));
        expect(calls[0]?.command).toBe(path.join(flutter, "dart.BAT"));
        expect(calls[0]?.shell).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});
