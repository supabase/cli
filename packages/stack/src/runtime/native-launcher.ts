// Standalone launcher boundary: this process owns the host process-group and
// invokes Effect only for bounded asynchronous lifecycle work.
import { Config, ConfigProvider, Duration, Effect, Option, Schema } from "effect";
import { Socket } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- FileSystem cannot adopt inherited fd3/fd4; Bun also requires synchronous fd4 reads at this process boundary.
import { createReadStream, readFileSync, utimesSync, writeSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- workloads join the launcher's process group and need child-only signal forwarding; Effect spawners signal child process groups.
import { spawn } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- this standalone process has no Effect FileSystem/SQLite service; it opens its own pin connection directly.
import { DatabaseSync } from "node:sqlite";
import { takeSharedLockSync } from "../namespace/drivers/sqlite-pin.ts";

/** Best-effort diagnostic: a write to a gone owner's stderr pipe must never end the launcher and release its pin. */
const report = (message: string): void => {
  try {
    writeSync(2, message);
  } catch {}
};

interface LaunchSpec {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly artifactLockPath?: string;
  readonly gracefulStopSignal?: "SIGTERM" | "SIGINT";
  readonly gracefulStopTimeoutMs?: number;
}

const LaunchSpecSchema = Schema.Struct({
  executable: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  uid: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  gid: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  artifactLockPath: Schema.optionalKey(Schema.String),
  gracefulStopSignal: Schema.optionalKey(Schema.Literals(["SIGTERM", "SIGINT"])),
  gracefulStopTimeoutMs: Schema.optionalKey(
    Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});
type DecodedLaunchSpec = Schema.Schema.Type<typeof LaunchSpecSchema>;

const decodeSpec = (bytes: Buffer): LaunchSpec | undefined => {
  const decoded = Schema.decodeOption(Schema.fromJsonString(LaunchSpecSchema))(
    bytes.toString("utf8"),
  );
  if (Option.isNone(decoded)) return undefined;
  const value: DecodedLaunchSpec = decoded.value;
  if ((value.gracefulStopSignal === undefined) !== (value.gracefulStopTimeoutMs === undefined))
    return undefined;
  {
    return {
      executable: value.executable,
      args: value.args ?? [],
      cwd: value.cwd,
      env: value.env,
      uid: value.uid,
      gid: value.gid,
      artifactLockPath: value.artifactLockPath,
      ...(value.gracefulStopSignal === undefined
        ? {}
        : { gracefulStopSignal: value.gracefulStopSignal }),
      ...(value.gracefulStopTimeoutMs === undefined
        ? {}
        : { gracefulStopTimeoutMs: value.gracefulStopTimeoutMs }),
    };
  }
};

/**
 * Takes this launcher's own SHARED pin on the workload's artifact generation before it spawns,
 * independent of whatever pin its owner process holds: the launcher outlives a dead owner, so its
 * own kernel lock is what keeps a concurrent retirement sweep from touching a generation whose
 * workload is still running. There is no heartbeat; the lock's mtime is touched once, here.
 */
const pinArtifactGeneration = (lockPath: string): (() => void) | undefined => {
  try {
    const connection = new DatabaseSync(lockPath);
    takeSharedLockSync(connection);
    // oxlint-disable-next-line effecttsgo/global-date -- this standalone process has no Effect Clock service to source "now" from.
    const now = new Date();
    utimesSync(lockPath, now, now);
    return () => {
      try {
        connection.close();
      } catch {
        // The workload has already exited; a failure to close is not actionable here.
      }
    };
  } catch (error) {
    report(`Unable to pin the native artifact generation: ${String(error)}\n`);
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

const inheritedEnvironment = Effect.gen(function* () {
  const environment: NodeJS.ProcessEnv = {};
  const provider = ConfigProvider.fromEnv();
  for (const name of inheritedEnvironmentNames) {
    const value = yield* Config.option(Config.String(name)).parse(provider);
    if (Option.isSome(value)) environment[name] = value.value;
  }
  return environment;
});

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
  let specGracefulStopSignal: LaunchSpec["gracefulStopSignal"];
  let specGracefulStopTimeoutMs: LaunchSpec["gracefulStopTimeoutMs"];
  let groupTerminated = false;
  let childExited = false;

  const terminateWorkloadGroup = (signal: NodeJS.Signals): void => {
    if (groupTerminated) return;
    groupTerminated = true;
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child?.pid ?? process.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    }
    try {
      // The workload owns a separate group so its descendants can be reaped
      // before this launcher exits while preserving the workload's exit code.
      process.kill(-(child?.pid ?? process.pid), signal);
    } catch {
      try {
        child?.kill(signal);
      } catch {}
    }
  };

  // Forwarding graceful signals to the workload rather than the whole process group keeps the
  // launcher alive long enough to observe and reap its exit. SIGKILL still goes through the
  // owner-pipe path and cannot be intercepted here.
  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (groupTerminated || gracefulForwarded) return;
    if (child === undefined) {
      terminateWorkloadGroup(signal);
      return;
    }
    gracefulForwarded = true;
    try {
      child.kill(signal);
    } catch {
      terminateWorkloadGroup(signal);
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
      terminateWorkloadGroup("SIGKILL");
      return;
    }
    let sent = false;
    try {
      sent = child.kill(specGracefulStopSignal);
    } catch {
      sent = false;
    }
    if (!sent) {
      terminateWorkloadGroup("SIGKILL");
      return;
    }
    ownerLossGraceful = true;
    // The fiber is process-scoped: the launcher exits on group termination, so
    // no detached work can outlive its owner process.
    Effect.runFork(
      Effect.sleep(Duration.millis(specGracefulStopTimeoutMs)).pipe(
        Effect.andThen(Effect.sync(() => terminateWorkloadGroup("SIGKILL"))),
      ),
    );
  };

  // Register the owner pipe before the launch payload: EOF means the owner vanished without
  // running a scope finalizer. Bun doesn't reliably surface EOF for an fd-based Socket, while
  // Node's fs stream can hold a libuv worker open after exit, so pick the adapter per runtime.
  const ownerPipe =
    process.versions.bun === undefined
      ? new Socket({ fd: 3, readable: true, writable: false })
      : createReadStream(process.platform === "win32" ? "NUL" : "/dev/null", {
          fd: 3,
          autoClose: false,
        });
  // Owner-loss is an abrupt owner crash, not an explicit graceful stop.
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
    // The parent writes a finite JSON payload and closes fd4; a synchronous read avoids a Bun
    // pipe-read stream that can fail to deliver `end` once the sink closes, while the owner-pipe
    // stream stays registered for loss detection once the workload is running.
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
    // Taken before spawning and released only after the workload's group has been sent SIGKILL,
    // on every exit path below, so a concurrent retirement sweep never races a running workload.
    const releasePin =
      spec.artifactLockPath === undefined
        ? undefined
        : pinArtifactGeneration(spec.artifactLockPath);
    if (spec.artifactLockPath !== undefined && releasePin === undefined) {
      // The pin could not be taken: never spawn a workload whose generation isn't protected.
      // Reporting nothing on fd5 is the same failure the owner already handles when the
      // launcher never writes a valid process group.
      process.exit(127);
      return;
    }
    /**
     * ESRCH (no such process group) counts as success: the group is already gone. A real failure
     * (for example EPERM) must never be treated as confirmation that it is.
     */
    const killGroupForExit = (pgid: number): boolean => {
      if (process.platform === "win32") return true;
      try {
        process.kill(-pgid, "SIGKILL");
        return true;
      } catch (error) {
        return (
          typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
        );
      }
    };
    // Once SIGKILL has reached every group member, none can run user code again, and unlinking
    // this generation's files afterward cannot affect an fd or mapping a member already holds
    // open: releasing the pin right after the kill, without waiting to confirm each member has
    // actually been reaped, is safe. A real kill failure must never reach `afterRelease`, since
    // exiting closes this process's own fd and reclaims the advisory lock regardless of whether
    // `releasePin` was ever called: staying alive and retrying is the only way to keep it held.
    const releaseAfterGroupKill = (afterRelease: () => void): void => {
      const pgid = child?.pid;
      if (releasePin === undefined) {
        afterRelease();
        return;
      }
      if (pgid === undefined) {
        releasePin();
        afterRelease();
        return;
      }
      const attempt = (reported: boolean): void => {
        if (killGroupForExit(pgid)) {
          releasePin();
          afterRelease();
          return;
        }
        if (!reported)
          report(
            "Unable to confirm the native workload's process group is gone; keeping its artifact generation pinned and retrying\n",
          );
        // oxlint-disable-next-line effecttsgo/global-timers -- this standalone process has no Effect runtime to schedule through.
        setTimeout(() => attempt(true), 1_000);
      };
      attempt(false);
    };
    child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: { ...Effect.runSync(inheritedEnvironment), ...spec.env },
      uid: spec.uid,
      gid: spec.gid,
      detached: true,
      stdio: ["inherit", "inherit", "inherit"],
    });
    try {
      writeSync(5, `${child.pid ?? 0}\n`);
    } catch {
      terminateWorkloadGroup("SIGKILL");
      releaseAfterGroupKill(() => process.exit(127));
      return;
    }
    child.on("error", (error) => {
      report(`Native workload failed to start: ${error.message}\n`);
      releaseAfterGroupKill(() => process.exit(127));
    });
    child.on("exit", (code, signal) => {
      childExited = true;
      terminateWorkloadGroup("SIGKILL");
      releaseAfterGroupKill(() => {
        if (ownerLossGraceful) {
          process.exit(code ?? 1);
          return;
        }
        ownerPipe.destroy();
        if (!gracefulForwarded && signal !== null)
          report(`Native workload exited due to signal ${signal}\n`);
        process.exit(code ?? 1);
      });
    });
  }
};

if (import.meta.main) {
  runNativeLauncher();
}
