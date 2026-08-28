import { Data, Effect, Option, Scope, Stream } from "effect";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import type {
  ChildProcessHandle,
  ExitCode,
  ProcessId,
} from "effect/unstable/process/ChildProcessSpawner";

export interface NativeProcessSpec {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/**
 * Command used for the process-ownership launcher. Workload arguments and
 * environment remain in the private fd4 payload; only this infrastructure
 * command appears in the launcher process argv.
 */
export interface NativeProcessLauncher {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class NativeProcessError extends Data.TaggedError("NativeProcessError")<{
  readonly message: string;
  readonly executable?: string;
  readonly cause?: unknown;
}> {}

export interface NativeProcess {
  readonly pid: ProcessId;
  readonly stdout: Stream.Stream<Uint8Array, NativeProcessError>;
  readonly stderr: Stream.Stream<Uint8Array, NativeProcessError>;
  readonly exitCode: Effect.Effect<ExitCode, NativeProcessError>;
  readonly isRunning: Effect.Effect<boolean, NativeProcessError>;
  readonly kill: Effect.Effect<void, NativeProcessError>;
}

const launcherPath = fileURLToPath(new URL("./native-launcher.ts", import.meta.url));

export const defaultNativeProcessLauncher = (): NativeProcessLauncher => ({
  command: process.execPath,
  args: [launcherPath],
});

const encodeSpec = (spec: NativeProcessSpec): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      executable: spec.executable,
      args: spec.args ?? [],
      env: spec.env,
      cwd: spec.cwd,
    }),
  );

const mapProcessError = (error: unknown, spec: NativeProcessSpec): NativeProcessError =>
  new NativeProcessError({
    message: error instanceof Error ? error.message : String(error),
    executable: spec.executable,
    cause: error,
  });

/**
 * Starts one native process through a tiny parent-loss-aware launcher. The
 * launcher receives an inherited pipe (fd3); closing this process scope closes
 * that pipe and terminates the exact process group. Normal process-tree
 * termination remains owned by Effect's ChildProcessSpawner.
 */
export const spawnNativeProcess = (
  spec: NativeProcessSpec,
  launcher: NativeProcessLauncher = defaultNativeProcessLauncher(),
): Effect.Effect<
  NativeProcess,
  NativeProcessError,
  import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const handle: ChildProcessHandle = yield* ChildProcess.make(launcher.command, launcher.args, {
      cwd: spec.cwd,
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      additionalFds: {
        fd3: { type: "input" },
        fd4: { type: "input" },
      },
    });
    yield* Stream.run(Stream.succeed(encodeSpec(spec)), handle.getInputFd(4));
    const mapError = <A>(
      effect: Effect.Effect<A, PlatformError>,
    ): Effect.Effect<A, NativeProcessError> =>
      effect.pipe(Effect.mapError((error) => mapProcessError(error, spec)));
    const mapStreamError = (
      stream: Stream.Stream<Uint8Array, PlatformError>,
    ): Stream.Stream<Uint8Array, NativeProcessError> =>
      stream.pipe(Stream.mapError((error) => mapProcessError(error, spec)));
    return {
      pid: handle.pid,
      stdout: mapStreamError(handle.stdout),
      stderr: mapStreamError(handle.stderr),
      exitCode: mapError(handle.exitCode),
      isRunning: mapError(handle.isRunning),
      kill: mapError(
        Effect.gen(function* () {
          // NodeChildProcessSpawner owns the exact process group. Its kill
          // effect sends the signal and waits for the launcher exit event;
          // bound that wait before forcing the same group.
          const graceful = yield* handle
            .kill({ killSignal: "SIGTERM" })
            .pipe(Effect.timeoutOption("2 seconds"));
          if (Option.isNone(graceful)) {
            const running = yield* handle.isRunning;
            if (running) yield* handle.kill({ killSignal: "SIGKILL" });
          }
        }),
      ),
    } satisfies NativeProcess;
  }).pipe(Effect.mapError((error) => mapProcessError(error, spec)));
