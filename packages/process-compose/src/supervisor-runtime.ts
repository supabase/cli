import { execFileSync, spawn } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "effect/unstable/process";
import type { ExternalCleanupAction } from "./ServiceDef.ts";
import {
  supervisorRuntimeConfigFromEnv,
  withoutSupervisorRuntimeEnv,
} from "./supervisor-protocol.ts";

type RemovePathAction = Extract<ExternalCleanupAction, { readonly _tag: "RemovePath" }>;

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

  const tag = getField(value, "_tag");
  if (tag === "DockerRemove") {
    const containerName = getField(value, "containerName");
    return typeof containerName === "string" ? { _tag: tag, containerName } : undefined;
  }

  if (tag === "RemovePath") {
    const path = getField(value, "path");
    const recursive = getField(value, "recursive");
    const force = getField(value, "force");
    return typeof path === "string"
      ? {
          _tag: tag,
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

  return {
    command,
    args: stringArrayFrom(getField(value, "args")),
    ownerPid: typeof ownerPid === "number" ? ownerPid : undefined,
    shutdownSignal: signalFrom(getField(value, "shutdownSignal")),
    shutdownTimeoutMs: typeof shutdownTimeoutMs === "number" ? shutdownTimeoutMs : undefined,
    cleanup: cleanupActionsFrom(getField(value, "cleanup")),
  };
};

export function runSupervisorRuntime(encodedConfig = process.argv[2]): void {
  if (encodedConfig == null) {
    throw new Error("Missing supervisor config");
  }

  const config = parseSupervisorRuntimeConfig(encodedConfig);
  const childEnv = withoutSupervisorRuntimeEnv();

  const isWindows = process.platform === "win32";
  const child = spawn(config.command, config.args ?? [], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !isWindows,
  });

  if (child.stdout != null) {
    child.stdout.pipe(process.stdout);
  }

  if (child.stderr != null) {
    child.stderr.pipe(process.stderr);
  }

  const childExited = new Promise<ChildExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let shuttingDown = false;
  let ownerWatcher: ReturnType<typeof setInterval> | undefined;

  const waitForChildExit = async (timeoutMs: number): Promise<boolean> => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        childExited.then(() => true),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId != null) {
        clearTimeout(timeoutId);
      }
    }
  };

  const killChildTree = (signal: ChildProcess.Signal): void => {
    if (child.pid == null) {
      return;
    }

    if (isWindows) {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5_000,
        });
      } catch {}

      return;
    }

    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}

    try {
      process.kill(child.pid, signal);
    } catch {}
  };

  const runCleanup = () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const removePathWithRetry = async (action: RemovePathAction): Promise<void> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          rmSync(action.path, {
            recursive: action.recursive ?? true,
            force: action.force ?? true,
          });
          return;
        } catch {}

        await sleep(250);
      }
    };

    return Promise.all(
      (config.cleanup ?? []).map(async (action) => {
        try {
          if (action._tag === "DockerRemove") {
            execFileSync("docker", ["rm", "-f", action.containerName], {
              stdio: "ignore",
              timeout: 5_000,
            });
          } else if (action._tag === "RemovePath") {
            await removePathWithRetry(action);
          }
        } catch {}
      }),
    ).then(() => undefined);
  };

  const shutdown = async (signal: ChildProcess.Signal): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (ownerWatcher != null) {
      clearInterval(ownerWatcher);
    }
    killChildTree(signal);

    const exitedGracefully = await waitForChildExit(config.shutdownTimeoutMs ?? 10_000);
    if (!exitedGracefully) {
      killChildTree("SIGKILL");
      await waitForChildExit(2_000);
    }

    await runCleanup();
    process.exit(0);
  };

  process.stdin.resume();
  process.stdin.on("end", () => {
    void shutdown(config.shutdownSignal ?? "SIGTERM");
  });
  process.stdin.on("close", () => {
    void shutdown(config.shutdownSignal ?? "SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  const ownerPid = typeof config.ownerPid === "number" ? config.ownerPid : undefined;
  const ownerAlive = () => {
    if (ownerPid == null) {
      return true;
    }

    try {
      process.kill(ownerPid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (!ownerAlive()) {
    void shutdown(config.shutdownSignal ?? "SIGTERM");
  } else {
    ownerWatcher = setInterval(() => {
      if (!ownerAlive()) {
        void shutdown(config.shutdownSignal ?? "SIGTERM");
      }
    }, 500);
    ownerWatcher.unref?.();
  }

  void childExited.then(async ({ code, signal }) => {
    if (shuttingDown) {
      return;
    }

    if (!ownerAlive() || (config.cleanup?.length ?? 0) > 0) {
      await runCleanup();
      process.exit(0);
      return;
    }

    if (signal != null) {
      process.exit(1);
      return;
    }

    process.exit(code ?? 0);
  });
}

if (isMain) {
  runSupervisorRuntime();
}

export function runSupervisorRuntimeFromEnv(env = process.env): void {
  runSupervisorRuntime(supervisorRuntimeConfigFromEnv(env));
}
