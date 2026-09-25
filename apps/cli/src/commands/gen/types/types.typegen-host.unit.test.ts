import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import type { SpawnRequest, SpawnResult } from "@supabase/typegen";
import { Data, Effect, FileSystem, Path, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeTypegenHost, quoteForCmd } from "./types.typegen-host.ts";

interface SpawnCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>> | undefined;
  readonly extendEnv: boolean | undefined;
  readonly shell: boolean | string | undefined;
  readonly stdin: string;
}

/** Records what `spawnForTypegen` asks for and answers like a finished process. */
function fakeSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly notFound?: boolean;
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
      const stdin = command.options.stdin;
      const stdinText =
        typeof stdin === "string" || stdin === undefined
          ? ""
          : yield* Stream.runFold(
              stdin as Stream.Stream<Uint8Array>,
              () => "",
              (text, chunk) => text + decoder.decode(chunk, { stream: true }),
            );
      calls.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        env: command.options.env,
        extendEnv: command.options.extendEnv,
        shell: command.options.shell,
        stdin: stdinText,
      });
      if (opts.notFound === true) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `${command.command} not found`,
        });
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        stdout: Stream.make(encoder.encode(opts.stdout ?? "")),
        stderr: Stream.make(encoder.encode(opts.stderr ?? "")),
        all: Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(opts.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
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

describe("quoteForCmd", () => {
  it("leaves plain tokens alone", () => {
    expect(quoteForCmd("run")).toBe("run");
    expect(quoteForCmd("--output")).toBe("--output");
    expect(quoteForCmd("C:\\flutter\\bin\\dart.bat")).toBe("C:\\flutter\\bin\\dart.bat");
  });

  it("quotes whitespace and cmd.exe metacharacters", () => {
    expect(quoteForCmd("C:\\Users\\Jane Doe\\dart.bat")).toBe('"C:\\Users\\Jane Doe\\dart.bat"');
    expect(quoteForCmd("C:\\tools & more\\dart.bat")).toBe('"C:\\tools & more\\dart.bat"');
    expect(quoteForCmd("a|b")).toBe('"a|b"');
    expect(quoteForCmd("(x)")).toBe('"(x)"');
  });

  it("doubles embedded quotes and percent signs", () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
    expect(quoteForCmd("%PATH%")).toBe('"%%PATH%%"');
  });
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

  it.effect(
    "runs the tool in the project directory with the document on stdin and returns its output",
    () =>
      Effect.gen(function* () {
        const { spawner, calls } = fakeSpawner({
          stdout: "class Tickets {}\n",
          stderr: "summary\n",
        });
        const result: SpawnResult = yield* spawnOf(spawner)(request());

        expect(result).toEqual({ exitCode: 0, stdout: "class Tickets {}\n", stderr: "summary\n" });
        expect(calls).toEqual([
          {
            command: "dart",
            args: ["run", "supabase_typegen", "--output", "-"],
            cwd: "/projects/app",
            env: { PATH: "/usr/bin" },
            extendEnv: true,
            shell: false,
            stdin: '{"version":1}',
          },
        ]);
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
