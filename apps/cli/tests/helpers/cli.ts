import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_VERSIONS } from "@supabase/stack/effect";
import {
  noteStackProjectHome,
  registerTempHome,
  registerTempStackProject,
} from "./stack-e2e-cleanup.ts";

const BINARY_EXT = process.platform === "win32" ? ".exe" : "";
const SHIM_PATH = fileURLToPath(new URL("../../dist/supabase.js", import.meta.url));
const LEGACY_BINARY_PATH = fileURLToPath(
  new URL(`../../dist/supabase-legacy${BINARY_EXT}`, import.meta.url),
);
const NEXT_BINARY_PATH = fileURLToPath(
  new URL(`../../dist/supabase-next${BINARY_EXT}`, import.meta.url),
);

function assertBuildArtifactsExist(shell: "legacy" | "next", binaryPath: string): void {
  if (!existsSync(SHIM_PATH) || !existsSync(binaryPath)) {
    throw new Error(
      `Missing ${shell} CLI build artifacts. Run \`pnpm --filter supabase build\` before invoking ${shell} e2e tests.\n` +
        `  expected shim:   ${SHIM_PATH}\n` +
        `  expected binary: ${binaryPath}`,
    );
  }
}

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_EXIT_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_LENGTH = 4_000;

interface SpawnedSupabase {
  readonly pid: number;
  readonly homeDir: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  readonly waitForExit: (timeoutMs?: number) => Promise<RunResult>;
}

export function makeTempHome() {
  const tempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(path.join(tempRoot, "sb-test-"));

  // Share the real binary cache so tests don't re-download binaries.
  const realBinDir = path.join(homedir(), ".supabase", "bin");
  if (existsSync(realBinDir)) {
    mkdirSync(dir, { recursive: true });
    symlinkSync(realBinDir, path.join(dir, "bin"));
  }

  const home = {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  registerTempHome(home);
  return home;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function makeTempProject(prefix = "supabase-project-e2e-") {
  const projectDir = await mkdtemp(path.join(tmpdir(), prefix));

  return {
    dir: projectDir,
    async cleanup() {
      await rm(projectDir, { recursive: true, force: true });
    },
  };
}

export async function makeTempStackProject(prefix = "supabase-stack-e2e-") {
  const project = await makeTempProject(prefix);
  const ports = {
    apiPort: await pickFreePort(),
    dbPort: await pickFreePort(),
    authPort: await pickFreePort(),
    postgrestPort: await pickFreePort(),
    postgrestAdminPort: await pickFreePort(),
    edgeRuntimePort: await pickFreePort(),
    edgeRuntimeInspectorPort: await pickFreePort(),
    realtimePort: await pickFreePort(),
    storagePort: await pickFreePort(),
    imgproxyPort: await pickFreePort(),
    mailpitPort: await pickFreePort(),
    mailpitSmtpPort: await pickFreePort(),
    mailpitPop3Port: await pickFreePort(),
    pgmetaPort: await pickFreePort(),
    studioPort: await pickFreePort(),
    analyticsPort: await pickFreePort(),
    poolerPort: await pickFreePort(),
    poolerApiPort: await pickFreePort(),
  };

  const stackDir = path.join(project.dir, ".supabase", "stacks", "default");
  await mkdir(stackDir, { recursive: true });
  await writeFile(
    path.join(stackDir, "stack.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        ports,
        services: DEFAULT_VERSIONS,
      },
      null,
      2,
    )}\n`,
  );

  const stackProject = {
    ...project,
    ports,
  };
  registerTempStackProject(stackProject);
  return stackProject;
}

/** Send a signal to the process group led by `pid`. */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

function outputTail(label: string, output: string): string {
  if (output.length === 0) {
    return `${label}: <empty>`;
  }

  const tail =
    output.length > OUTPUT_TAIL_LENGTH ? output.slice(output.length - OUTPUT_TAIL_LENGTH) : output;
  return `${label}:\n${tail}`;
}

export function spawnSupabase(
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
    home?: string;
    /** Write this string to stdin, then close it. */
    stdin?: string;
    /** Whether to kill the whole process group once the root process exits. */
    cleanupProcessGroupOnClose?: boolean;
    /** Maximum time to wait for the process to exit before force-killing it. */
    exitTimeoutMs?: number;
    /** Which source entrypoint to execute. */
    entrypoint?: "next" | "legacy";
  },
): SpawnedSupabase {
  const ownHome = options?.home ? null : makeTempHome();
  const homeDir = options?.home ?? ownHome!.dir;
  noteStackProjectHome(options?.cwd, homeDir);
  const entrypoint = options?.entrypoint ?? "next";
  const usesStartWrapper = args[0] === "start";
  // Exercise the same shim + compiled shell binary handoff that published
  // packages use. `SUPABASE_CLI_BINARY_OVERRIDE` points the shim at the local
  // build artifact without needing platform wrapper packages.
  let execCmd: string;
  let execArgs: string[];
  const env: Record<string, string> = {
    ...process.env,
    SUPABASE_HOME: homeDir,
    SUPABASE_NO_KEYRING: "1",
    SUPABASE_TELEMETRY_DISABLED: "1",
    ...options?.env,
  };
  if (entrypoint === "legacy") {
    assertBuildArtifactsExist("legacy", LEGACY_BINARY_PATH);
    env["SUPABASE_CLI_BINARY_OVERRIDE"] = LEGACY_BINARY_PATH;
  } else {
    assertBuildArtifactsExist("next", NEXT_BINARY_PATH);
    env["SUPABASE_CLI_BINARY_OVERRIDE"] = NEXT_BINARY_PATH;
  }
  execCmd = "node";
  execArgs = [SHIM_PATH, ...args];
  const proc = spawn(execCmd, execArgs, {
    cwd: options?.cwd,
    env,
    stdio:
      usesStartWrapper || options?.stdin !== undefined
        ? ["pipe", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe"],
    // Own process group so tests can distinguish product cleanup from helper cleanup.
    detached: true,
  });
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;

  if (stdoutStream == null || stderrStream == null) {
    throw new Error("Expected spawned Supabase process to expose stdout/stderr pipes");
  }

  let stdout = "";
  let stderr = "";
  let closeResult: RunResult | undefined;
  let cleanedUpProcessGroup = false;
  let disposedOwnHome = false;
  const closeWaiters = new Set<(result: RunResult) => void>();

  const cleanupProcessGroupOnClose = () => {
    if (cleanedUpProcessGroup || !(options?.cleanupProcessGroupOnClose ?? true)) {
      return;
    }
    cleanedUpProcessGroup = true;
    killProcessGroup(proc.pid!, "SIGKILL");
  };

  const disposeOwnHome = () => {
    if (disposedOwnHome) {
      return;
    }
    disposedOwnHome = true;
    ownHome?.[Symbol.dispose]();
  };

  stdoutStream.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  stderrStream.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  proc.once("close", (code) => {
    closeResult = { stdout, stderr, exitCode: code ?? 1 };
    for (const waiter of closeWaiters) {
      waiter(closeResult);
    }
    closeWaiters.clear();
  });

  if (options?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const waitForExit = async (
    timeoutMs = options?.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS,
  ): Promise<RunResult> => {
    if (closeResult) {
      cleanupProcessGroupOnClose();
      disposeOwnHome();
      return closeResult;
    }

    const result = await new Promise<RunResult>((resolve) => {
      const timeout = setTimeout(() => {
        killProcessGroup(proc.pid!, "SIGKILL");
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, timeoutMs);
      timeout.unref();

      const onClose = (result: RunResult) => {
        clearTimeout(timeout);
        closeWaiters.delete(onClose);
        cleanupProcessGroupOnClose();
        resolve(result);
      };

      closeWaiters.add(onClose);
    });

    disposeOwnHome();
    return result;
  };

  return {
    pid: proc.pid!,
    homeDir,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: (signal = "SIGTERM") => {
      killProcessGroup(proc.pid!, signal);
      try {
        proc.kill(signal);
      } catch {}
    },
    waitForOutput: async (pattern: RegExp, timeoutMs = 60_000) => {
      if (pattern.test(stdout)) {
        return;
      }
      if (closeResult) {
        throw new Error(
          [
            `Process exited before output matched ${pattern}`,
            `Command: supabase ${args.join(" ")}`,
            `PID: ${proc.pid ?? "<unknown>"}`,
            outputTail("stdout tail", stdout),
            outputTail("stderr tail", stderr),
          ].join("\n\n"),
        );
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              [
                `Timed out waiting for output matching ${pattern}`,
                `Command: supabase ${args.join(" ")}`,
                `PID: ${proc.pid ?? "<unknown>"}`,
                outputTail("stdout tail", stdout),
                outputTail("stderr tail", stderr),
              ].join("\n\n"),
            ),
          );
        }, timeoutMs);

        const onStdout = (_data: Buffer) => {
          if (pattern.test(stdout)) {
            cleanup();
            resolve();
          }
        };

        const onClose = () => {
          cleanup();
          reject(
            new Error(
              [
                `Process exited before output matched ${pattern}`,
                `Command: supabase ${args.join(" ")}`,
                `PID: ${proc.pid ?? "<unknown>"}`,
                outputTail("stdout tail", stdout),
                outputTail("stderr tail", stderr),
              ].join("\n\n"),
            ),
          );
        };

        const cleanup = () => {
          clearTimeout(timeout);
          stdoutStream.off("data", onStdout);
          proc.off("close", onClose);
        };

        stdoutStream.on("data", onStdout);
        proc.on("close", onClose);
      });
    },
    waitForExit,
  };
}

export async function runSupabase(
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
    home?: string;
    /** Write this string to stdin, then close it. */
    stdin?: string;
    /** Kill the process as soon as stdout matches this pattern. */
    until?: RegExp;
    /** How long to wait for the `until` pattern before failing. */
    untilTimeoutMs?: number;
    /** Maximum time to wait for the command to exit before force-killing it. */
    exitTimeoutMs?: number;
    /** Which source entrypoint to execute. */
    entrypoint?: "next" | "legacy";
  },
): Promise<RunResult> {
  const spawned = spawnSupabase(args, options);
  let killedByUntil = false;

  if (options?.until) {
    await spawned.waitForOutput(options.until, options.untilTimeoutMs);
    killedByUntil = true;
    spawned.kill("SIGTERM");

    const timer = setTimeout(() => {
      killProcessGroup(spawned.pid, "SIGKILL");
    }, 15_000);
    timer.unref();
  }

  const result = await spawned.waitForExit();
  return { ...result, exitCode: killedByUntil ? 0 : result.exitCode };
}
