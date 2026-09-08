// oxlint-disable effecttsgo/process-env -- standalone launcher reads inherited allowlisted variables before Effect starts.
// oxlint-disable effecttsgo/global-timers -- standalone launcher grace deadline runs before Effect starts.
// Standalone launcher boundary: this process must remain usable before the
// Effect runtime exists and therefore talks to the host directly.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { Socket } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { createReadStream, readFileSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { spawn } from "node:child_process";

interface LaunchSpec {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly gracefulStopSignal?: "SIGTERM" | "SIGINT";
  readonly gracefulStopTimeoutMs?: number;
}

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const decodeSpec = (bytes: Buffer): LaunchSpec | undefined => {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value) || typeof value.executable !== "string") return undefined;
    const args: string[] = [];
    if (value.args !== undefined) {
      if (!Array.isArray(value.args)) return undefined;
      for (const arg of value.args) {
        if (typeof arg !== "string") return undefined;
        args.push(arg);
      }
    }
    if (value.cwd !== undefined && typeof value.cwd !== "string") return undefined;
    let env: Record<string, string> | undefined;
    if (value.env !== undefined) {
      if (!isRecord(value.env)) return undefined;
      env = {};
      for (const [name, entry] of Object.entries(value.env)) {
        if (typeof entry !== "string") return undefined;
        env[name] = entry;
      }
    }
    if (
      value.gracefulStopSignal !== undefined &&
      value.gracefulStopSignal !== "SIGTERM" &&
      value.gracefulStopSignal !== "SIGINT"
    )
      return undefined;
    if (
      value.gracefulStopTimeoutMs !== undefined &&
      (typeof value.gracefulStopTimeoutMs !== "number" ||
        !Number.isFinite(value.gracefulStopTimeoutMs) ||
        value.gracefulStopTimeoutMs < 0)
    )
      return undefined;
    if ((value.gracefulStopSignal === undefined) !== (value.gracefulStopTimeoutMs === undefined))
      return undefined;
    return {
      executable: value.executable,
      args,
      cwd: value.cwd,
      env,
      ...(value.gracefulStopSignal === undefined
        ? {}
        : { gracefulStopSignal: value.gracefulStopSignal }),
      ...(value.gracefulStopTimeoutMs === undefined
        ? {}
        : { gracefulStopTimeoutMs: value.gracefulStopTimeoutMs }),
    };
  } catch {
    return undefined;
  }
};

const inheritedEnvironmentNames = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
] as const;

const inheritedEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

/**
 * Runs the standalone native launcher entrypoint.
 *
 * Keeping this work behind an explicit function lets a compiled CLI dispatch
 * the launcher from its embedded module graph. Direct source execution still
 * enters through the `import.meta.main` guard below.
 */
export const runNativeLauncher = (): void => {
  let child: ReturnType<typeof spawn> | undefined;
  let gracefulForwarded = false;
  let ownerLost = false;
  let ownerLossGraceful = false;
  let gracefulTimeout: ReturnType<typeof setTimeout> | undefined;
  let specGracefulStopSignal: LaunchSpec["gracefulStopSignal"];
  let specGracefulStopTimeoutMs: LaunchSpec["gracefulStopTimeoutMs"];
  let groupTerminated = false;
  let childExited = false;

  const terminateGroup = (signal: NodeJS.Signals): void => {
    if (groupTerminated) return;
    groupTerminated = true;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(process.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    try {
      // The launcher is the detached process-group leader, so this targets only
      // the process tree created for this workload.
      process.kill(-process.pid, signal);
    } catch {
      child?.kill(signal);
    }
  };

  // The supervisor normally signals the launcher process group, but forwarding
  // graceful signals to the workload keeps the launcher alive long enough to
  // observe the workload's exit and reap it. SIGKILL remains handled by the
  // owner-pipe path and cannot be intercepted here.
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (groupTerminated || gracefulForwarded) return;
    if (child === undefined) {
      terminateGroup(signal);
      return;
    }
    gracefulForwarded = true;
    try {
      child.kill(signal);
    } catch {
      terminateGroup(signal);
    }
  };
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGINT", () => forwardSignal("SIGINT"));

  const handleOwnerLoss = (): void => {
    if (ownerLost || groupTerminated) return;
    ownerLost = true;
    if (
      child === undefined ||
      specGracefulStopSignal === undefined ||
      specGracefulStopTimeoutMs === undefined
    ) {
      terminateGroup("SIGKILL");
      return;
    }
    let sent = false;
    try {
      sent = child.kill(specGracefulStopSignal);
    } catch {
      sent = false;
    }
    if (!sent) {
      terminateGroup("SIGKILL");
      return;
    }
    ownerLossGraceful = true;
    gracefulTimeout = setTimeout(() => terminateGroup("SIGKILL"), specGracefulStopTimeoutMs);
  };

  // Register the owner pipe before waiting for the launch payload. EOF means
  // the owner process disappeared without running a normal scope finalizer.
  // Bun does not reliably surface EOF for a net.Socket created from this
  // descriptor, while Node's filesystem stream can hold a libuv worker open
  // after its owner exits. Select the descriptor adapter for the host runtime.
  const ownerPipe =
    process.versions.bun === undefined
      ? new Socket({ fd: 3, readable: true, writable: false })
      : createReadStream(process.platform === "win32" ? "NUL" : "/dev/null", {
          fd: 3,
          autoClose: false,
        });
  // Owner-loss is an abrupt supervisor crash, not an explicit graceful stop.
  // Apply a workload's bounded graceful policy when present, then guarantee
  // tree termination so descendants cannot be orphaned after owner loss.
  ownerPipe.on("end", handleOwnerLoss);
  ownerPipe.on("error", handleOwnerLoss);
  ownerPipe.on("close", () => {
    if (!childExited) handleOwnerLoss();
  });
  ownerPipe.resume();

  let payload: Buffer;
  try {
    // The parent writes a finite JSON payload and closes fd4. A synchronous
    // read avoids a Bun pipe-read stream that can fail to deliver `end` after
    // the parent closes the sink, while the owner stream remains registered for
    // loss detection once the workload is running.
    payload = readFileSync(4);
  } catch {
    process.exit(127);
  }
  const spec = decodeSpec(payload);
  if (spec === undefined || groupTerminated) {
    process.exit(127);
  } else {
    specGracefulStopSignal = spec.gracefulStopSignal;
    specGracefulStopTimeoutMs = spec.gracefulStopTimeoutMs;
    child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...inheritedEnvironment(), ...spec.env },
      detached: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => process.exit(127));
    child.on("exit", (code) => {
      childExited = true;
      if (gracefulTimeout !== undefined) clearTimeout(gracefulTimeout);
      if (ownerLossGraceful) {
        terminateGroup("SIGKILL");
        return;
      }
      ownerPipe.destroy();
      process.exit(code ?? 1);
    });
  }
};

if (import.meta.main) {
  runNativeLauncher();
}
