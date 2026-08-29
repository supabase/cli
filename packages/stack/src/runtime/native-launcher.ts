// Standalone launcher boundary: this process must remain usable before the
// Effect runtime exists and therefore talks to the host directly.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { Socket } from "node:net";
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { spawn } from "node:child_process";

interface LaunchSpec {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
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
    let env: Record<string, string | undefined> | undefined;
    if (value.env !== undefined) {
      if (!isRecord(value.env)) return undefined;
      env = {};
      for (const [name, entry] of Object.entries(value.env)) {
        if (entry !== undefined && typeof entry !== "string") return undefined;
        env[name] = entry;
      }
    }
    return {
      executable: value.executable,
      args,
      cwd: value.cwd,
      env,
    };
  } catch {
    return undefined;
  }
};

let child: ReturnType<typeof spawn> | undefined;
let terminating = false;

const terminateGroup = (signal: NodeJS.Signals): void => {
  if (terminating) return;
  terminating = true;
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

// Register the owner pipe before waiting for the launch payload. EOF means
// the owner process disappeared without running a normal scope finalizer.
const ownerPipe = new Socket({ fd: 3, readable: true, writable: false });
// Owner-loss is an abrupt supervisor crash, not an explicit graceful stop.
// Use guaranteed tree termination so descendants that trap SIGTERM cannot be
// orphaned after the owner pipe closes.
ownerPipe.on("end", () => terminateGroup("SIGKILL"));
ownerPipe.on("error", () => terminateGroup("SIGKILL"));
ownerPipe.resume();

const payloadPipe = new Socket({ fd: 4, readable: true, writable: false });
const payload: Buffer[] = [];
payloadPipe.on("data", (chunk: Buffer) => payload.push(chunk));
payloadPipe.on("error", () => process.exit(127));
payloadPipe.on("end", () => {
  const spec = decodeSpec(Buffer.concat(payload));
  if (spec === undefined || terminating) {
    process.exit(127);
    return;
  }
  child = spawn(spec.executable, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env === undefined ? process.env : { ...spec.env },
    detached: false,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", () => process.exit(127));
  child.on("exit", (code, signal) => {
    ownerPipe.destroy();
    process.exit(code ?? (signal === null ? 1 : 1));
  });
});
