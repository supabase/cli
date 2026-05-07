import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { runSupabase } from "./cli.ts";

type TempHome = {
  readonly dir: string;
  readonly dispose: () => void;
};

type StackProject = {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
  homeDir?: string;
};

interface StackRuntimeSnapshot {
  readonly stateFiles: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
  readonly stackDirs: ReadonlyArray<string>;
  readonly trackedPids: ReadonlyArray<number>;
}

interface CleanupEnvironment {
  readonly stopStack: (projectDir: string, homeDir: string) => Promise<{ exitCode: number }>;
  readonly captureSnapshot: (projectDir: string) => StackRuntimeSnapshot;
  readonly waitForCleanup: (projectDir: string, snapshot: StackRuntimeSnapshot) => Promise<boolean>;
  readonly forceCleanup: (projectDir: string, snapshot: StackRuntimeSnapshot) => Promise<void>;
}

interface StackE2eCleanupManager {
  registerHome(home: TempHome): void;
  registerStackProject(project: {
    readonly dir: string;
    readonly cleanup: () => Promise<void>;
  }): void;
  associateHome(projectDir: string, homeDir: string): void;
  drain(): Promise<void>;
  reset(): void;
}

function normalizeDir(dir: string): string {
  return path.resolve(dir);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePsTable(): Array<{
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
}> {
  try {
    const output = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (match == null) {
          return undefined;
        }
        return {
          pid: Number.parseInt(match[1]!, 10),
          ppid: Number.parseInt(match[2]!, 10),
          command: match[3] ?? "",
        };
      })
      .filter(
        (
          entry,
        ): entry is { readonly pid: number; readonly ppid: number; readonly command: string } =>
          entry != null,
      );
  } catch {
    return [];
  }
}

function descendantPids(
  rootPids: ReadonlyArray<number>,
  table: ReadonlyArray<{ readonly pid: number; readonly ppid: number }>,
): Array<number> {
  const visited = new Set<number>();
  const pending = [...rootPids];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const row of table) {
      if (row.ppid === current) {
        pending.push(row.pid);
      }
    }
  }

  return [...visited];
}

function readStatePid(stateFile: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as { readonly pid?: number };
    return parsed.pid;
  } catch {
    return undefined;
  }
}

function ownerSummary(targetPath: string): string {
  try {
    const stat = statSync(targetPath);
    return `${targetPath} uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o777).toString(8)}`;
  } catch (error) {
    return `${targetPath} <stat failed: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

function cleanupErrorDetail(projectDir: string, error: unknown): string {
  const code =
    error != null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const errorPath =
    error != null && typeof error === "object" && "path" in error ? String(error.path) : projectDir;
  const lines = [
    `Failed to remove temp stack project ${projectDir}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  ];

  if (code === "EACCES" || code === "EPERM") {
    lines.push("Ownership diagnostics:");
    lines.push(ownerSummary(projectDir));
    if (errorPath !== projectDir) {
      lines.push(ownerSummary(errorPath));
    }

    try {
      for (const entry of readdirSync(projectDir, { withFileTypes: true }).slice(0, 20)) {
        lines.push(ownerSummary(path.join(projectDir, entry.name)));
      }
    } catch (listError) {
      lines.push(
        `Failed to list ${projectDir}: ${
          listError instanceof Error ? listError.message : String(listError)
        }`,
      );
    }
  }

  return lines.join("\n");
}

function captureSnapshot(projectDir: string): StackRuntimeSnapshot {
  const normalized = normalizeDir(projectDir);
  const stacksRoot = path.join(normalized, ".supabase", "stacks");
  if (!existsSync(stacksRoot)) {
    return {
      stateFiles: [],
      socketPaths: [],
      stackDirs: [],
      trackedPids: [],
    };
  }

  const stackDirs: Array<string> = [];
  const stateFiles: Array<string> = [];
  const socketPaths: Array<string> = [];

  for (const entry of readdirSync(stacksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const stackDir = path.join(stacksRoot, entry.name);
    stackDirs.push(stackDir);
    const stateFile = path.join(stackDir, "state.json");
    const socketPath = path.join(stackDir, "daemon.sock");
    if (existsSync(stateFile)) {
      stateFiles.push(stateFile);
    }
    if (existsSync(socketPath)) {
      socketPaths.push(socketPath);
    }
  }

  const rootPids = stateFiles
    .map(readStatePid)
    .filter((pid): pid is number => pid != null && pid > 0);
  const table = parsePsTable();
  const descendants = descendantPids(rootPids, table);
  const commandPids = table.filter((row) => row.command.includes(normalized)).map((row) => row.pid);

  return {
    stateFiles,
    socketPaths,
    stackDirs,
    trackedPids: [...new Set([...descendants, ...commandPids])].sort((left, right) => left - right),
  };
}

async function waitForCleanup(
  projectDir: string,
  snapshot: StackRuntimeSnapshot,
): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const nextSnapshot = captureSnapshot(projectDir);
    const filesGone = nextSnapshot.stateFiles.length === 0 && nextSnapshot.socketPaths.length === 0;
    const pidsGone = snapshot.trackedPids.every((pid) => !isProcessAlive(pid));
    if (filesGone && pidsGone) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

async function forceCleanup(projectDir: string, snapshot: StackRuntimeSnapshot): Promise<void> {
  for (const pid of snapshot.trackedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  for (const stackDir of snapshot.stackDirs) {
    try {
      rmSync(stackDir, { recursive: true, force: true });
    } catch {}
  }

  const stacksRoot = path.join(normalizeDir(projectDir), ".supabase", "stacks");
  try {
    rmSync(stacksRoot, { recursive: true, force: true });
  } catch {}
}

function createRealEnvironment(): CleanupEnvironment {
  return {
    stopStack: async (projectDir, homeDir) => {
      const result = await runSupabase(["stop", "--no-backup"], {
        cwd: projectDir,
        home: homeDir,
        exitTimeoutMs: 15_000,
      });
      return { exitCode: result.exitCode };
    },
    captureSnapshot,
    waitForCleanup,
    forceCleanup,
  };
}

export function createStackE2eCleanupManager(
  environment: CleanupEnvironment = createRealEnvironment(),
): StackE2eCleanupManager {
  const homes = new Map<string, TempHome>();
  const projects = new Map<string, StackProject>();

  return {
    registerHome(home) {
      homes.set(normalizeDir(home.dir), home);
    },
    registerStackProject(project) {
      projects.set(normalizeDir(project.dir), {
        dir: normalizeDir(project.dir),
        cleanup: project.cleanup,
      });
    },
    associateHome(projectDir, homeDir) {
      const project = projects.get(normalizeDir(projectDir));
      if (project !== undefined) {
        project.homeDir = normalizeDir(homeDir);
      }
    },
    async drain() {
      const pendingProjects = [...projects.values()];
      const pendingHomes = new Map(homes);
      projects.clear();
      homes.clear();

      const failures: Array<string> = [];

      for (const project of pendingProjects) {
        const home = project.homeDir ? pendingHomes.get(project.homeDir) : undefined;
        const snapshot = environment.captureSnapshot(project.dir);
        const hasRuntimeArtifacts =
          snapshot.stateFiles.length > 0 ||
          snapshot.socketPaths.length > 0 ||
          snapshot.trackedPids.some((pid) => isProcessAlive(pid));
        let stopExitCode: number | undefined;

        if (hasRuntimeArtifacts && project.homeDir !== undefined) {
          const stopResult = await environment.stopStack(project.dir, project.homeDir);
          stopExitCode = stopResult.exitCode;
        }

        if (hasRuntimeArtifacts) {
          const cleaned = await environment.waitForCleanup(project.dir, snapshot);
          if (!cleaned) {
            await environment.forceCleanup(project.dir, snapshot);
            failures.push(
              stopExitCode != null && stopExitCode !== 0
                ? `Centralized e2e cleanup detected leaked stack resources for ${project.dir} after stop exited ${stopExitCode}.`
                : `Centralized e2e cleanup detected leaked stack resources for ${project.dir}.`,
            );
          }
        }

        try {
          await project.cleanup();
        } catch (error) {
          failures.push(cleanupErrorDetail(project.dir, error));
        } finally {
          if (home !== undefined) {
            home.dispose();
          }
        }
      }

      if (failures.length > 0) {
        throw new Error(failures.join("\n"));
      }
    },
    reset() {
      homes.clear();
      projects.clear();
    },
  };
}

const manager = createStackE2eCleanupManager();

export function registerTempHome(home: {
  readonly dir: string;
  readonly [Symbol.dispose]: () => void;
}): void {
  manager.registerHome({
    dir: home.dir,
    dispose: () => home[Symbol.dispose](),
  });
}

export function registerTempStackProject(project: {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}): void {
  manager.registerStackProject(project);
}

export function noteStackProjectHome(projectDir: string | undefined, homeDir: string): void {
  if (projectDir === undefined) {
    return;
  }
  manager.associateHome(projectDir, homeDir);
}

export async function cleanupRegisteredStackProjects(): Promise<void> {
  await manager.drain();
}
