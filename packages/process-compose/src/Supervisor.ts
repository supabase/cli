import { fileURLToPath } from "node:url";
import { ChildProcess } from "effect/unstable/process";
import type { ExternalCleanupAction, ServiceDef } from "./ServiceDef.ts";
import { defaults } from "./ServiceDef.ts";

interface SupervisorRuntimeConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly ownerPid: number;
  readonly shutdownSignal: ChildProcess.Signal;
  readonly shutdownTimeoutMs: number;
  readonly cleanup: ReadonlyArray<ExternalCleanupAction>;
}

export const supervisorRuntimePath = fileURLToPath(
  new URL("./supervisor-runtime.mjs", import.meta.url),
);

export const usesSupervisor = (def: ServiceDef): boolean => def.supervision != null;

const supervisorCommand =
  process.execPath.includes("/node") || process.execPath.endsWith("\\node.exe")
    ? process.execPath
    : "node";

export const makeSupervisedCommand = (def: ServiceDef) => {
  const runtimeConfig: SupervisorRuntimeConfig = {
    command: def.command,
    args: def.args ?? [],
    ownerPid: process.pid,
    shutdownSignal: def.shutdown?.signal ?? defaults.shutdown.signal,
    shutdownTimeoutMs: (def.shutdown?.timeoutSeconds ?? defaults.shutdown.timeoutSeconds) * 1000,
    cleanup: def.supervision?.orphanCleanup ?? [],
  };
  const encoded = Buffer.from(JSON.stringify(runtimeConfig)).toString("base64url");

  return ChildProcess.make(supervisorCommand, [supervisorRuntimePath, encoded], {
    cwd: def.cwd,
    env: def.env,
    extendEnv: true,
    stdin: "pipe",
    // Detach the supervisor from the Bun parent so it can survive abrupt owner
    // death long enough to observe stdin/ownerPid changes and run cleanup.
    detached: true,
  });
};
