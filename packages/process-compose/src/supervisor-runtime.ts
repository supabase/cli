import { execFileSync, spawn } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Deferred, Duration, Effect, Fiber, Match, Option, Predicate, Schedule } from "effect";
import type { ChildProcess } from "effect/unstable/process";
import type { ExternalCleanupAction } from "./ServiceDef.ts";
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
  readonly signal: NodeJS.Signals | null;
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

  try {
    return realpathSync(process.argv[1]) === realpathSync(runtimePath);
  } catch {
    return process.argv[1] === runtimePath;
  }
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

const killProcessTree = (pid: number, signal: ChildProcess.Signal): void => {
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}

    return;
  }

  try {
    process.kill(-pid, signal);
    return;
  } catch {}

  try {
    process.kill(pid, signal);
  } catch {}
};

const isWindows = process.platform === "win32";

const waitForExit = (
  childExit: Deferred.Deferred<ChildExit>,
  timeoutMs: number,
): Effect.Effect<boolean> =>
  Deferred.await(childExit).pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.map(Option.isSome),
  );

const runSupervisorRuntimeEffect = (config: SupervisorRuntimeConfig): Effect.Effect<void> =>
  Effect.scoped(
    Effect.gen(function* () {
      const childEnv = withoutSupervisorRuntimeEnv();
      const child = yield* Effect.sync(() =>
        spawn(config.command, config.args ?? [], {
          cwd: process.cwd(),
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: !isWindows,
        }),
      );
      if (child.stdout != null) child.stdout.pipe(process.stdout);
      if (child.stderr != null) child.stderr.pipe(process.stderr);

      const childExit = yield* Deferred.make<ChildExit>();
      const shutdownRequest = yield* Deferred.make<ChildProcess.Signal>();
      const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
        Effect.runSync(Deferred.succeed(childExit, { code, signal }));
      };
      child.once("exit", onChildExit);

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
      const requestShutdown = (signal: ChildProcess.Signal) => {
        Effect.runSync(Deferred.succeed(shutdownRequest, signal));
      };

      process.stdin.resume();
      const onStdinEnd = () => requestShutdown(config.shutdownSignal ?? "SIGTERM");
      const onStdinClose = () => requestShutdown(config.shutdownSignal ?? "SIGTERM");
      const onSigInt = () => requestShutdown("SIGINT");
      const onSigTerm = () => requestShutdown("SIGTERM");
      process.stdin.on("end", onStdinEnd);
      process.stdin.on("close", onStdinClose);
      process.on("SIGINT", onSigInt);
      process.on("SIGTERM", onSigTerm);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.removeListener("exit", onChildExit);
          process.stdin.removeListener("end", onStdinEnd);
          process.stdin.removeListener("close", onStdinClose);
          process.removeListener("SIGINT", onSigInt);
          process.removeListener("SIGTERM", onSigTerm);
          if (child.pid != null) killProcessTree(child.pid, "SIGKILL");
        }),
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
        Effect.sync(() => {
          if (child.pid != null) killProcessTree(child.pid, signal);
        });

      const runCleanupCommand = (action: RunCommandAction): Effect.Effect<void> =>
        Effect.callback<void>((resume) => {
          const cleanupChild = spawn(action.executable, action.args, {
            detached: !isWindows,
            env: childEnv,
            stdio: "ignore",
          });
          const finish = () => resume(Effect.void);
          cleanupChild.once("error", finish);
          cleanupChild.once("exit", finish);
          return Effect.sync(() => {
            cleanupChild.removeListener("error", finish);
            cleanupChild.removeListener("exit", finish);
            if (cleanupChild.pid != null) killProcessTree(cleanupChild.pid, "SIGKILL");
          });
        }).pipe(
          Effect.timeoutOption(
            Duration.millis(action.timeoutMs ?? DEFAULT_CLEANUP_COMMAND_TIMEOUT_MS),
          ),
          Effect.asVoid,
          Effect.catch(() => Effect.void),
        );

      const runCleanup = Effect.gen(function* () {
        const removePathWithRetry = (action: RemovePathAction) =>
          Effect.try({
            try: () => {
              rmSync(action.path, {
                recursive: action.recursive ?? true,
                force: action.force ?? true,
              });
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.retry(Schedule.spaced(Duration.millis(250)).pipe(Schedule.upTo({ times: 19 }))),
            Effect.catch(() => Effect.void),
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
          Effect.map((exit): SupervisorOutcome => ({ _tag: "ChildExited", exit })),
        ),
      );

      yield* Fiber.interrupt(ownerWatcher);
      yield* Match.valueTags(outcome, {
        ShutdownRequested: ({ signal }) =>
          Effect.gen(function* () {
            yield* shutdown(signal);
            yield* runCleanup;
            yield* Effect.sync(() => process.exit(0));
          }),
        ChildExited: ({ exit: { code, signal } }) =>
          Effect.gen(function* () {
            if (!ownerAlive() || (config.cleanup?.length ?? 0) > 0) {
              yield* runCleanup;
              yield* Effect.sync(() => process.exit(0));
            } else if (signal != null) {
              yield* Effect.sync(() => process.exit(1));
            } else {
              yield* Effect.sync(() => process.exit(code ?? 0));
            }
          }),
      });
    }),
  );

export function runSupervisorRuntime(encodedConfig = process.argv[2]): void {
  if (encodedConfig == null) throw new Error("Missing supervisor config");
  const config = parseSupervisorRuntimeConfig(encodedConfig);
  void Effect.runPromise(runSupervisorRuntimeEffect(config)).catch(() => process.exit(1));
}

if (isMain) {
  runSupervisorRuntime();
}

export function runSupervisorRuntimeFromEnv(env = process.env): void {
  runSupervisorRuntime(supervisorRuntimeConfigFromEnv(env));
}
