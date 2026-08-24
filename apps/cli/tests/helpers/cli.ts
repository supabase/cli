import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  noteStackProjectHome,
  registerTempHome,
  registerTempStackProject,
} from "./stack-e2e-cleanup.ts";

export { stripAnsi } from "./ansi.ts";

const BINARY_EXT = process.platform === "win32" ? ".exe" : "";
const SHIM_PATH = fileURLToPath(new URL("../../dist/supabase.js", import.meta.url));
const LEGACY_BINARY_PATH = fileURLToPath(
  new URL(`../../dist/supabase-legacy${BINARY_EXT}`, import.meta.url),
);
const NEXT_BINARY_PATH = fileURLToPath(
  new URL(`../../dist/supabase-next${BINARY_EXT}`, import.meta.url),
);

// E2E subprocesses should only enter agent output mode when a test explicitly
// opts in via `options.env`. Keep this list aligned with @vercel/detect-agent
// env probes so a developer's shell cannot accidentally change CLI rendering.
const AGENT_DETECTION_ENV_KEYS: readonly string[] = [
  "AI_AGENT",
  "CURSOR_TRACE_ID",
  "CURSOR_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "CLAUDE_CODE_IS_COWORK",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
];

function subprocessBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of AGENT_DETECTION_ENV_KEYS) delete env[key];
  // Keep test spawns hermetic: never let the upgrade notice hit GitHub or
  // print into asserted output. Tests exercising the notice override this.
  env["SUPABASE_NO_UPDATE_NOTIFIER"] = "1";
  return env;
}

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
const DEFAULT_LEGACY_STACK_CLEANUP_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_LENGTH = 4_000;

interface SpawnedSupabase {
  readonly pid: number;
  readonly homeDir: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly kill: (signal?: NodeJS.Signals) => void;
  readonly waitForOutput: (pattern: RegExp, timeoutMs?: number, startAt?: number) => Promise<void>;
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

/**
 * Rewrites every active port assignment in an `init`-generated
 * `supabase/config.toml` with a freshly allocated free port, so stacks started
 * from default configs cannot collide on host ports with other e2e stacks on
 * the same runner. Commented-out port lines are left untouched.
 */
export async function overrideStackPorts(projectDir: string) {
  const configPath = path.join(projectDir, "supabase", "config.toml");
  const config = await readFile(configPath, "utf8");
  const assigned = new Set<number>();
  const lines: string[] = [];
  for (const line of config.split("\n")) {
    const match = /^(\s*(?:port|smtp_port|pop3_port|inspector_port|shadow_port) = )\d+$/.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    let port = await pickFreePort();
    while (assigned.has(port)) {
      port = await pickFreePort();
    }
    assigned.add(port);
    lines.push(`${match[1]}${port}`);
  }
  await writeFile(configPath, lines.join("\n"));
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

/** Create an isolated CLI project without pre-allocating released ports. */
export async function makeTempCliProject(prefix = "supabase-cli-e2e-") {
  const project = await makeTempProject(prefix);
  registerTempStackProject(project);
  return project;
}

export async function makeTempLegacyStackProject(
  prefix = "supabase-legacy-stack-e2e-",
  cleanupTimeoutMs = DEFAULT_LEGACY_STACK_CLEANUP_TIMEOUT_MS,
) {
  const project = await makeTempProject(prefix);
  const cleanup = async () => {
    if (!existsSync(project.dir)) return;

    // `init` can fail before creating a project config. There is no stack to
    // stop in that case, so remove the exact owned directory directly.
    if (!existsSync(path.join(project.dir, "supabase", "config.toml"))) {
      await rm(project.dir, { recursive: true, force: true });
      return;
    }

    const stopped = await runSupabase(["stop", "--no-backup"], {
      entrypoint: "legacy",
      cwd: project.dir,
      exitTimeoutMs: cleanupTimeoutMs,
    });
    if (stopped.exitCode !== 0) {
      throw new Error(
        [
          `Failed to stop legacy stack in ${project.dir} (exit code ${stopped.exitCode}).`,
          `stdout:\n${stopped.stdout}`,
          `stderr:\n${stopped.stderr}`,
        ].join("\n"),
      );
    }

    await rm(project.dir, { recursive: true, force: true });
  };

  const stackProject = { dir: project.dir, cleanup };
  registerTempStackProject(stackProject);
  return stackProject;
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

  const supabaseDir = path.join(project.dir, "supabase");
  await mkdir(supabaseDir, { recursive: true });
  await writeFile(
    path.join(supabaseDir, "config.toml"),
    [
      'project_id = "e2e"',
      "",
      "[api]",
      `port = ${ports.apiPort}`,
      "",
      "[db]",
      `port = ${ports.dbPort}`,
      "",
      "[db.pooler]",
      `port = ${ports.poolerPort}`,
      "",
      "[edge_runtime]",
      `inspector_port = ${ports.edgeRuntimeInspectorPort}`,
      "",
      "[local_smtp]",
      `port = ${ports.mailpitPort}`,
      `smtp_port = ${ports.mailpitSmtpPort}`,
      `pop3_port = ${ports.mailpitPop3Port}`,
      "",
      "[studio]",
      `port = ${ports.studioPort}`,
      "",
      "[analytics]",
      `port = ${ports.analyticsPort}`,
      "",
    ].join("\n"),
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
    ...subprocessBaseEnv(),
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
    waitForOutput: async (pattern: RegExp, timeoutMs = 60_000, startAt = 0) => {
      pattern.lastIndex = 0;
      if (pattern.test(stdout.slice(startAt))) {
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
          pattern.lastIndex = 0;
          if (pattern.test(stdout.slice(startAt))) {
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

export function requireCliSuccess(
  result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  command: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed (exit ${result.exitCode})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}
