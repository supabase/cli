import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { PlatformError } from "effect/PlatformError";

type ShellCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
};

export interface CliRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export const runCliEffect = (
  binPath: string,
  args: ReadonlyArray<string>,
): Effect.Effect<CliRunResult, PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(binPath, args, {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const result = yield* Effect.all(
        {
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          exitCode: handle.exitCode,
        },
        { concurrency: "unbounded" },
      );
      return {
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
        exitCode: result.exitCode,
      };
    }),
  );

/** Promise facade for the release smoke script's executable edge. */
export function runCli(binPath: string, args: Array<string>): Promise<CliRunResult> {
  return Effect.runPromise(runCliEffect(binPath, args).pipe(Effect.provide(BunServices.layer)));
}

export const verifyExpectedShellEffect = (
  binPath: string,
): Effect.Effect<ShellCheckResult, PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const result = yield* runCliEffect(binPath, ["init", "--help"]);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const passed = result.exitCode === 0 && output.includes("init");
    return {
      passed,
      detail: passed
        ? 'dispatch ok: "init --help" succeeded'
        : `expected dispatch via "init --help", got exit=${result.exitCode}, stdout=${result.stdout}, stderr=${result.stderr}`,
    };
  });

/** Promise facade for the release smoke script's executable edge. */
export function verifyExpectedShell(binPath: string): Promise<ShellCheckResult> {
  return Effect.runPromise(
    verifyExpectedShellEffect(binPath).pipe(Effect.provide(BunServices.layer)),
  );
}
