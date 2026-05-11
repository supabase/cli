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
  readonly stacksRootExists: boolean;
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
  readonly removeProjectWithDocker: (projectDir: string) => Promise<boolean>;
  readonly repairProjectPermissions: (projectDir: string) => void;
  readonly describeProjectPermissions: (projectDir: string) => string;
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

function cleanupErrorDetail(projectDir: string, error: unknown): string {
  return `Failed to remove temp stack project ${projectDir}: ${
    error instanceof Error ? error.message : String(error)
  }`;
}

function isPermissionError(error: unknown): boolean {
  const code =
    error != null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  return code === "EACCES" || code === "EPERM";
}

function formatMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function describePath(pathname: string): string {
  try {
    const stats = statSync(pathname);
    return `${pathname} uid=${stats.uid} gid=${stats.gid} mode=${formatMode(stats.mode)}`;
  } catch (error) {
    return `${pathname} ${error instanceof Error ? error.message : String(error)}`;
  }
}

function describeProjectPermissions(projectDir: string): string {
  const stacksRoot = path.join(projectDir, ".supabase", "stacks");
  const details = [
    "Permission diagnostics:",
    describePath(projectDir),
    describePath(path.join(projectDir, ".supabase")),
    describePath(stacksRoot),
  ];

  try {
    const entries = readdirSync(stacksRoot).slice(0, 20);
    details.push(
      entries.length === 0
        ? `${stacksRoot} entries=<empty>`
        : `${stacksRoot} entries=${entries.join(",")}`,
    );
  } catch {}

  return details.join("\n");
}

function repairProjectPermissions(projectDir: string): void {
  try {
    execFileSync("chmod", ["-R", "u+rwX", projectDir], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } catch {}
}

async function removeProjectWithDocker(projectDir: string): Promise<boolean> {
  const parentDir = path.dirname(projectDir);
  const projectName = path.basename(projectDir);

  try {
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "0:0",
        "-v",
        `${parentDir}:/parent`,
        "-e",
        `TARGET_NAME=${projectName}`,
        "--entrypoint",
        "sh",
        "public.ecr.aws/docker/library/busybox:1.36",
        "-c",
        'cd /parent && rm -rf -- "$TARGET_NAME"',
      ],
      { stdio: "ignore", timeout: 30_000 },
    );
  } catch {}

  return !existsSync(projectDir);
}

async function cleanupProject(
  project: StackProject,
  environment: Pick<
    CleanupEnvironment,
    "removeProjectWithDocker" | "repairProjectPermissions" | "describeProjectPermissions"
  >,
): Promise<void> {
  try {
    await project.cleanup();
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }

    const removedByDocker = await environment.removeProjectWithDocker(project.dir);
    if (removedByDocker) {
      return;
    }

    environment.repairProjectPermissions(project.dir);
    try {
      await project.cleanup();
    } catch (retryError) {
      throw new Error(
        `${retryError instanceof Error ? retryError.message : String(retryError)}\n${environment.describeProjectPermissions(
          project.dir,
        )}`,
      );
    }
  }
}

function captureSnapshot(projectDir: string): StackRuntimeSnapshot {
  const normalized = normalizeDir(projectDir);
  const stacksRoot = path.join(normalized, ".supabase", "stacks");
  if (!existsSync(stacksRoot)) {
    return {
      stacksRootExists: false,
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
    stacksRootExists: true,
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
    removeProjectWithDocker,
    repairProjectPermissions,
    describeProjectPermissions,
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
        const hasStackPersistence = snapshot.stacksRootExists || snapshot.stackDirs.length > 0;
        let stopExitCode: number | undefined;

        if (hasStackPersistence && project.homeDir !== undefined) {
          try {
            const stopResult = await environment.stopStack(project.dir, project.homeDir);
            stopExitCode = stopResult.exitCode;
          } catch {
            stopExitCode = 1;
          }
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
          await cleanupProject(project, environment);
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
