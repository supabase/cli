import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

interface SpawnedSupabase {
  readonly pid: number;
  readonly homeDir: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly waitForOutput: (pattern: RegExp, timeoutMs?: number) => Promise<void>;
  readonly waitForExit: () => Promise<RunResult>;
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

  return {
    dir,
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Send a signal to the process group led by `pid`. */
function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

export function spawnSupabase(
  args: string[],
  options?: {
    env?: Record<string, string>;
    /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
    home?: string;
    /** Write this string to stdin, then close it. */
    stdin?: string;
    /** Whether to kill the whole process group once the root process exits. */
    cleanupProcessGroupOnClose?: boolean;
  },
): SpawnedSupabase {
  const ownHome = options?.home ? null : makeTempHome();
  const homeDir = options?.home ?? ownHome!.dir;
  const sourceCliLauncher = fileURLToPath(new URL("./source-cli-launcher.mjs", import.meta.url));
  const sourceCliEntrypoint = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const usesStartWrapper = args[0] === "start";
  const proc = spawn(
    usesStartWrapper ? "node" : "bun",
    usesStartWrapper
      ? [sourceCliLauncher, sourceCliEntrypoint, ...args]
      : [sourceCliEntrypoint, ...args],
    {
      env: {
        ...process.env,
        SUPABASE_HOME: homeDir,
        SUPABASE_NO_KEYRING: "1",
        ...options?.env,
      },
      stdio:
        usesStartWrapper || options?.stdin !== undefined
          ? ["pipe", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe"],
      // Own process group so tests can distinguish product cleanup from helper cleanup.
      detached: true,
    },
  );
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;

  if (stdoutStream == null || stderrStream == null) {
    throw new Error("Expected spawned Supabase process to expose stdout/stderr pipes");
  }

  let stdout = "";
  let stderr = "";

  stdoutStream.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  stderrStream.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  if (options?.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const waitForExit = async (): Promise<RunResult> => {
    const result = await new Promise<RunResult>((resolve) => {
      proc.on("close", (code) => {
        if (options?.cleanupProcessGroupOnClose ?? true) {
          killProcessGroup(proc.pid!, "SIGKILL");
        }

        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });

    ownHome?.[Symbol.dispose]();
    return result;
  };

  return {
    pid: proc.pid!,
    homeDir,
    stdout: () => stdout,
    stderr: () => stderr,
    kill: (signal = "SIGTERM") => {
      proc.kill(signal);
    },
    waitForOutput: async (pattern: RegExp, timeoutMs = 60_000) => {
      if (pattern.test(stdout)) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for output matching ${pattern}`));
        }, timeoutMs);

        const onStdout = (_data: Buffer) => {
          if (pattern.test(stdout)) {
            cleanup();
            resolve();
          }
        };

        const onClose = () => {
          cleanup();
          reject(new Error(`Process exited before output matched ${pattern}`));
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
    env?: Record<string, string>;
    /** Reuse a temp SUPABASE_HOME directory instead of creating a new one per call. */
    home?: string;
    /** Write this string to stdin, then close it. */
    stdin?: string;
    /** Kill the process as soon as stdout matches this pattern. */
    until?: RegExp;
    /** How long to wait for the `until` pattern before failing. */
    untilTimeoutMs?: number;
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
