import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import type { SpawnRequest } from "@supabase/typegen";
import { Effect, PlatformError, Sink, Stream } from "effect";
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
  it("runs the tool in the project directory with the document on stdin and returns its output", async () => {
    const { spawner, calls } = fakeSpawner({ stdout: "class Tickets {}\n", stderr: "summary\n" });
    const spawn = host(spawner).spawn;
    expect(spawn).toBeDefined();
    const result = await spawn!(request());

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
  });

  it("reports a non-zero exit as a result rather than a failure", async () => {
    const { spawner } = fakeSpawner({ exitCode: 65, stderr: "Could not parse the document\n" });
    const result = await host(spawner).spawn!(request());
    expect(result.exitCode).toBe(65);
    expect(result.stderr).toBe("Could not parse the document\n");
  });

  it("rejects a missing executable with ENOENT, as the registry's Host contract asks", async () => {
    const { spawner } = fakeSpawner({ notFound: true });
    await expect(host(spawner).spawn!(request())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hands TypeScript back unformatted", async () => {
    const { spawner } = fakeSpawner();
    const code = "export type Database = {}";
    expect(await host(spawner).format!(code, "output.ts")).toBe(code);
  });

  describe("on Windows", () => {
    let dir: string;
    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "typegen-host-")));
      mkdirSync(join(dir, "flutter"));
      writeFileSync(join(dir, "flutter", "dart.BAT"), "@echo off\r\n");
      chmodSync(join(dir, "flutter", "dart.BAT"), 0o755);
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    // The registry's lookup joins Windows paths, which only exist on a Windows filesystem.
    it.skipIf(process.platform !== "win32")(
      "runs a .bat found through PATH and PATHEXT through the command interpreter",
      async () => {
        const { spawner, calls } = fakeSpawner({ stdout: "ok" });
        const env = { PATH: join(dir, "flutter"), PATHEXT: ".EXE;.BAT" };
        const windowsHost = host(spawner, "win32", env);
        await windowsHost.spawn!(request({ env }));
        expect(calls[0]?.command).toBe(join(dir, "flutter", "dart.BAT"));
        expect(calls[0]?.shell).toBe(true);
      },
    );

    it("rejects with ENOENT without spawning when PATH holds no candidate", async () => {
      const { spawner, calls } = fakeSpawner();
      const env = { PATH: join(dir, "empty"), PATHEXT: ".EXE;.BAT" };
      await expect(host(spawner, "win32", env).spawn!(request({ env }))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(calls).toEqual([]);
    });
  });
});
