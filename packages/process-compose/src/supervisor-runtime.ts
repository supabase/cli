import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Match,
  Option,
  Predicate,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as PlatformError from "effect/PlatformError";
import type { ExternalCleanupAction } from "./ServiceDef.ts";
import { childSignalFromCause } from "./ChildSignal.ts";
import { writeChunk } from "./Writable.ts";
import {
  supervisorRuntimeConfigFromEnv,
  withoutSupervisorRuntimeEnv,
} from "./supervisor-protocol.ts";

type RemovePathAction = Extract<ExternalCleanupAction, { readonly _tag: "RemovePath" }>;
type RunCommandAction = Extract<ExternalCleanupAction, { readonly _tag: "RunCommand" }>;

interface SupervisorRuntimeConfig {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly ownerPid?: number;
  readonly shutdownSignal?: ChildProcess.Signal;
  readonly shutdownTimeoutMs?: number;
  readonly cleanup?: ReadonlyArray<ExternalCleanupAction>;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: ChildProcess.Signal | null;
}

type SupervisorOutcome =
  | { readonly _tag: "ShutdownRequested"; readonly signal: ChildProcess.Signal }
  | { readonly _tag: "ChildExited"; readonly exit: ChildExit };

const DEFAULT_CLEANUP_COMMAND_TIMEOUT_MS = 5_000;

const isMain = (() => {
  if (process.argv[1] == null) {
    return false;
  }

  const runtimePath = fileURLToPath(import.meta.url);
  if (!runtimePath.endsWith("supervisor-runtime.ts")) {
    return false;
  }

  return process.argv[1] === runtimePath;
})();

const getField = (value: object, key: string): unknown => Reflect.get(value, key);

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const stringArrayFrom = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.every((item) => typeof item === "string") ? value : undefined;
};

const signalFrom = (value: unknown): ChildProcess.Signal | undefined => {
  switch (value) {
    case "SIGABRT":
    case "SIGALRM":
    case "SIGBUS":
    case "SIGCHLD":
    case "SIGCONT":
    case "SIGFPE":
    case "SIGHUP":
    case "SIGILL":
    case "SIGINT":
    case "SIGIO":
    case "SIGIOT":
    case "SIGKILL":
    case "SIGPIPE":
    case "SIGPOLL":
    case "SIGPROF":
    case "SIGPWR":
    case "SIGQUIT":
    case "SIGSEGV":
    case "SIGSTKFLT":
    case "SIGSTOP":
    case "SIGSYS":
    case "SIGTERM":
    case "SIGTRAP":
    case "SIGTSTP":
    case "SIGTTIN":
    case "SIGTTOU":
    case "SIGUNUSED":
    case "SIGURG":
    case "SIGUSR1":
    case "SIGUSR2":
    case "SIGVTALRM":
    case "SIGWINCH":
    case "SIGXCPU":
    case "SIGXFSZ":
    case "SIGBREAK":
    case "SIGLOST":
    case "SIGINFO":
      return value;
    default:
      return undefined;
  }
};

const cleanupActionFrom = (value: unknown): ExternalCleanupAction | undefined => {
  if (!isObject(value)) {
    return undefined;
  }

  if (Predicate.isTagged(value, "RunCommand")) {
    const executable = getField(value, "executable");
    const args = stringArrayFrom(getField(value, "args"));
    const timeoutMs = getField(value, "timeoutMs");
    if (
      typeof executable !== "string" ||
      executable.length === 0 ||
      args === undefined ||
      (timeoutMs !== undefined &&
        (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0))
    ) {
      return undefined;
    }
    return {
      _tag: "RunCommand",
      executable,
      args,
      timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
    };
  }

  if (Predicate.isTagged(value, "RemovePath")) {
    const path = getField(value, "path");
    const recursive = getField(value, "recursive");
    const force = getField(value, "force");
    return typeof path === "string" &&
      path.length > 0 &&
      (recursive === undefined || typeof recursive === "boolean") &&
      (force === undefined || typeof force === "boolean")
      ? {
          _tag: "RemovePath",
          path,
          recursive: typeof recursive === "boolean" ? recursive : undefined,
          force: typeof force === "boolean" ? force : undefined,
        }
      : undefined;
  }

  return undefined;
};

const cleanupActionsFrom = (value: unknown): ReadonlyArray<ExternalCleanupAction> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const actions = value.map(cleanupActionFrom);
  return actions.every((action) => action != null) ? actions : undefined;
};

const parseSupervisorRuntimeConfig = (encodedConfig: string): SupervisorRuntimeConfig => {
  const value: unknown = JSON.parse(Buffer.from(encodedConfig, "base64url").toString("utf8"));
  if (!isObject(value)) {
    throw new Error("Invalid supervisor config");
  }

  const command = getField(value, "command");
  if (typeof command !== "string") {
    throw new Error("Invalid supervisor command");
  }

  const ownerPid = getField(value, "ownerPid");
  const shutdownTimeoutMs = getField(value, "shutdownTimeoutMs");
  const cleanupValue = getField(value, "cleanup");
  const cleanup = cleanupValue === undefined ? undefined : cleanupActionsFrom(cleanupValue);
  if (cleanupValue !== undefined && cleanup === undefined) {
    throw new Error("Invalid supervisor cleanup");
  }

  return {
    command,
    args: stringArrayFrom(getField(value, "args")),
    ownerPid: typeof ownerPid === "number" ? ownerPid : undefined,
    shutdownSignal: signalFrom(getField(value, "shutdownSignal")),
    shutdownTimeoutMs: typeof shutdownTimeoutMs === "number" ? shutdownTimeoutMs : undefined,
    cleanup,
  };
};

const killProcessTree = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  pid: number,
  signal: ChildProcess.Signal,
): Effect.Effect<void, PlatformError.PlatformError> => {
  if (isWindows) {
    return Effect.scoped(
      Effect.gen(function* () {
        const taskkill = yield* spawner.spawn(
          ChildProcess.make("taskkill", ["/PID", String(pid), "/T", "/F"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* taskkill.exitCode.pipe(Effect.timeout(Duration.seconds(5)), Effect.asVoid);
      }),
    ).pipe(Effect.ignore);
  }

  return Effect.sync(() => {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}

    try {
      process.kill(pid, signal);
    } catch {}
  });
};

const isWindows = process.platform === "win32";

const waitForExit = (
  childExit: Deferred.Deferred<Exit.Exit<ChildExit, PlatformError.PlatformError>>,
  timeoutMs: number,
): Effect.Effect<boolean, PlatformError.PlatformError> =>
  Deferred.await(childExit).pipe(
    Effect.flatMap((result) =>
      Exit.isSuccess(result) ? Effect.succeed(true) : Effect.failCause(result.cause),
    ),
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.map(Option.isSome),
  );

const runSupervisorRuntimeEffect = (
  config: SupervisorRuntimeConfig,
): Effect.Effect<
  void,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const childEnv = withoutSupervisorRuntimeEnv();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const shutdownRequest = yield* Deferred.make<ChildProcess.Signal>();
      const requestShutdown = (signal: ChildProcess.Signal) =>
        Deferred.doneUnsafe(shutdownRequest, Effect.succeed(signal));
      const onStdinEnd = () => requestShutdown(config.shutdownSignal ?? "SIGTERM");
      const onStdinClose = () => requestShutdown(config.shutdownSignal ?? "SIGTERM");
      const onSigInt = () => requestShutdown("SIGINT");
      const onSigTerm = () => requestShutdown("SIGTERM");

      process.stdin.on("end", onStdinEnd);
      process.stdin.on("close", onStdinClose);
      process.on("SIGINT", onSigInt);
      process.on("SIGTERM", onSigTerm);
      process.stdin.resume();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.stdin.removeListener("end", onStdinEnd);
          process.stdin.removeListener("close", onStdinClose);
          process.removeListener("SIGINT", onSigInt);
          process.removeListener("SIGTERM", onSigTerm);
        }),
      );

      const child = yield* spawner.spawn(
        ChildProcess.make(config.command, config.args ?? [], {
          cwd: process.cwd(),
          env: childEnv,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: !isWindows,
        }),
      );

      yield* Stream.runForEach(child.stdout, (chunk) => writeChunk(process.stdout, chunk)).pipe(
        Effect.forkChild,
        Effect.ignore,
      );
      yield* Stream.runForEach(child.stderr, (chunk) => writeChunk(process.stderr, chunk)).pipe(
        Effect.forkChild,
        Effect.ignore,
      );

      const childExit = yield* Deferred.make<Exit.Exit<ChildExit, PlatformError.PlatformError>>();
      yield* child.exitCode.pipe(
        Effect.exit,
        Effect.flatMap((result) => {
          if (Exit.isSuccess(result)) {
            return Deferred.succeed(
              childExit,
              Exit.succeed({ code: result.value, signal: null } satisfies ChildExit),
            );
          }

          const signal = Option.getOrUndefined(childSignalFromCause(result.cause));
          return signal === undefined
            ? Deferred.succeed(childExit, Exit.failCause(result.cause))
            : Deferred.succeed(childExit, Exit.succeed({ code: null, signal } satisfies ChildExit));
        }),
        Effect.forkChild,
      );

      const ownerPid = typeof config.ownerPid === "number" ? config.ownerPid : undefined;
      const ownerAlive = () => {
        if (ownerPid == null) return true;
        try {
          process.kill(ownerPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      yield* Effect.addFinalizer(() =>
        killProcessTree(spawner, child.pid, "SIGKILL").pipe(Effect.ignore),
      );

      const ownerWatcher = yield* Effect.forkChild(
        Effect.repeat(
          Effect.gen(function* () {
            if (!ownerAlive()) {
              yield* Deferred.succeed(shutdownRequest, config.shutdownSignal ?? "SIGTERM");
            }
          }),
          Schedule.spaced(Duration.millis(500)),
        ),
      );

      const killChildTree = (signal: ChildProcess.Signal) =>
        killProcessTree(spawner, child.pid, signal);

      const runCleanupCommand = (action: RunCommandAction): Effect.Effect<void> =>
        Effect.scoped(
          Effect.gen(function* () {
            const cleanupChild = yield* spawner.spawn(
              ChildProcess.make(action.executable, action.args, {
                detached: !isWindows,
                env: childEnv,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              }),
            );
            const exited = yield* cleanupChild.exitCode.pipe(
              Effect.timeoutOption(
                Duration.millis(action.timeoutMs ?? DEFAULT_CLEANUP_COMMAND_TIMEOUT_MS),
              ),
            );
            if (Option.isNone(exited)) {
              yield* killProcessTree(spawner, cleanupChild.pid, "SIGKILL");
            }
          }),
        ).pipe(Effect.ignore);

      const runCleanup = Effect.gen(function* () {
        const removePathWithRetry = (action: RemovePathAction) =>
          fs
            .remove(action.path, {
              recursive: action.recursive ?? true,
              force: action.force ?? true,
            })
            .pipe(
              Effect.retry(
                Schedule.spaced(Duration.millis(250)).pipe(Schedule.upTo({ times: 19 })),
              ),
              Effect.ignore,
            );
        yield* Effect.all(
          [
            Effect.forEach(
              config.cleanup ?? [],
              (action) =>
                Predicate.isTagged(action, "RunCommand") ? runCleanupCommand(action) : Effect.void,
              { concurrency: 1, discard: true },
            ),
            Effect.forEach(
              config.cleanup ?? [],
              (action) =>
                Predicate.isTagged(action, "RemovePath")
                  ? removePathWithRetry(action)
                  : Effect.void,
              { concurrency: "unbounded", discard: true },
            ),
          ],
          { discard: true },
        );
      });

      const shutdown = (signal: ChildProcess.Signal) =>
        Effect.gen(function* () {
          yield* killChildTree(signal);
          const exitedGracefully = yield* waitForExit(
            childExit,
            config.shutdownTimeoutMs ?? 10_000,
          );
          if (!exitedGracefully) {
            yield* killChildTree("SIGKILL");
            yield* waitForExit(childExit, 2_000);
          }
        });

      const outcome = yield* Effect.race(
        Deferred.await(shutdownRequest).pipe(
          Effect.map((signal): SupervisorOutcome => ({ _tag: "ShutdownRequested", signal })),
        ),
        Deferred.await(childExit).pipe(
          Effect.flatMap((result) =>
            Exit.isSuccess(result)
              ? Effect.succeed({
                  _tag: "ChildExited",
                  exit: result.value,
                } satisfies SupervisorOutcome)
              : Effect.failCause(result.cause),
          ),
        ),
      );

      return yield* Match.valueTags(outcome, {
        ShutdownRequested: ({ signal }) =>
          Effect.gen(function* () {
            yield* Fiber.interrupt(ownerWatcher).pipe(Effect.exit);
            yield* shutdown(signal);
            yield* runCleanup;
            return yield* Effect.sync(() => process.exit(0));
          }),
        ChildExited: ({ exit: { code, signal } }) =>
          Effect.gen(function* () {
            yield* Fiber.interrupt(ownerWatcher).pipe(Effect.exit);
            if (!ownerAlive() || (config.cleanup?.length ?? 0) > 0) {
              yield* runCleanup;
              return yield* Effect.sync(() => process.exit(0));
            } else if (signal != null) {
              return yield* Effect.sync(() => process.exit(1));
            } else {
              return yield* Effect.sync(() => process.exit(code ?? 0));
            }
          }),
      });
    }),
  );

export function runSupervisorRuntime(encodedConfig = process.argv[2]): void {
  if (encodedConfig == null) throw new Error("Missing supervisor config");
  const config = parseSupervisorRuntimeConfig(encodedConfig);
  void Effect.runPromise(
    runSupervisorRuntimeEffect(config).pipe(Effect.provide(BunServices.layer)),
  ).catch(() => process.exit(1));
}

if (isMain) {
  runSupervisorRuntime();
}

export function runSupervisorRuntimeFromEnv(env = process.env): void {
  runSupervisorRuntime(supervisorRuntimeConfigFromEnv(env));
}
