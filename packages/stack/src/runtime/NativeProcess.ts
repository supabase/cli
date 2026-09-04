import { Data, Duration, Effect, Option, Scope, Stream } from "effect";
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
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Signal used for an explicit graceful stop before the forced kill fallback. */
  readonly gracefulStopSignal?: "SIGTERM" | "SIGINT";
  /** Graceful-stop budget for this workload. */
  readonly gracefulStopTimeout?: Duration.Input;
  /** Maximum time allowed for this service-owned one-shot process. */
  readonly timeout?: Duration.Input;
  /** Exact lifecycle witness written after a successful one-shot process. */
  readonly successMarker?: string;
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

/** Stable command-line marker used by diagnostics to identify owned processes. */
export interface NativeProcessIdentity {
  readonly stackId: string;
  readonly workloadId: string;
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

/** Private argv marker used when a compiled CLI dispatches its embedded native launcher. */
export const NATIVE_PROCESS_DISPATCH_SENTINEL = "__supabase_stack_native__" as const;

const isBunVirtualPath = (value: string): boolean => /(?:^|[\\/])\$bunfs(?:[\\/]|$)/.test(value);

export const nativeLauncherEntrypointFor = (moduleUrl: string): string => {
  if (isBunVirtualPath(moduleUrl)) return NATIVE_PROCESS_DISPATCH_SENTINEL;
  const sourceEntrypoint = fileURLToPath(new URL("./native-launcher.ts", moduleUrl));
  return isBunVirtualPath(sourceEntrypoint) ? NATIVE_PROCESS_DISPATCH_SENTINEL : sourceEntrypoint;
};

export const defaultNativeProcessLauncher = (): NativeProcessLauncher => ({
  command: process.execPath,
  args: [nativeLauncherEntrypointFor(import.meta.url)],
});

const encodeSpec = (spec: NativeProcessSpec): Uint8Array => {
  const timeout =
    spec.gracefulStopSignal === undefined
      ? Option.none<number>()
      : Duration.fromInput(spec.gracefulStopTimeout ?? "2 seconds").pipe(
          Option.filter(Duration.isFinite),
          Option.map(Duration.toMillis),
          Option.filter((millis) => Number.isFinite(millis) && millis >= 0),
        );
  return new TextEncoder().encode(
    JSON.stringify({
      executable: spec.executable,
      args: spec.args ?? [],
      env: spec.env,
      cwd: spec.cwd,
      ...(Option.isSome(timeout)
        ? {
            gracefulStopSignal: spec.gracefulStopSignal,
            gracefulStopTimeoutMs: timeout.value,
          }
        : {}),
    }),
  );
};

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
  identity?: NativeProcessIdentity,
): Effect.Effect<
  NativeProcess,
  NativeProcessError,
  import("effect/unstable/process/ChildProcessSpawner").ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const launcherArgs =
      identity === undefined
        ? launcher.args
        : [
            ...launcher.args,
            "--",
            `supabase-stack-id=${identity.stackId}`,
            `supabase-workload-id=${identity.workloadId}`,
          ];
    const handle: ChildProcessHandle = yield* ChildProcess.make(launcher.command, launcherArgs, {
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
    const cleanupProcessGroup = Effect.try({
      try: () => {
        if (globalThis.process.platform === "win32") return;
        try {
          globalThis.process.kill(-Number(handle.pid), "SIGKILL");
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ESRCH"
          )
            return;
          throw error;
        }
      },
      catch: (error) => mapProcessError(error, spec),
    });
    const exitCode = yield* Effect.cached(
      mapError(handle.exitCode).pipe(
        Effect.tap(
          () =>
            // The launcher exits with the workload's code, but its descendants
            // can keep the detached process group alive. The parent still owns
            // that exact group, so terminate it after capturing the exit code.
            cleanupProcessGroup,
        ),
      ),
    );
    return {
      pid: handle.pid,
      stdout: mapStreamError(handle.stdout),
      stderr: mapStreamError(handle.stderr),
      exitCode,
      isRunning: mapError(handle.isRunning),
      kill: mapError(
        Effect.gen(function* () {
          // NodeChildProcessSpawner owns the exact process group. Its kill
          // effect sends the signal and waits for the launcher exit event;
          // bound that wait before forcing the same group.
          const graceful = yield* handle
            .kill({ killSignal: spec.gracefulStopSignal ?? "SIGTERM" })
            .pipe(Effect.timeoutOption(spec.gracefulStopTimeout ?? "2 seconds"));
          if (Option.isNone(graceful)) {
            const running = yield* handle.isRunning;
            if (running) yield* handle.kill({ killSignal: "SIGKILL" });
          }
        }),
      ),
    } satisfies NativeProcess;
  }).pipe(Effect.mapError((error) => mapProcessError(error, spec)));
