import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StackState } from "../../src/StateManager.ts";

export interface LeakSnapshot {
  readonly stateDirs: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
  readonly states: ReadonlyArray<StackState>;
  readonly tempDataDirs: ReadonlyArray<string>;
  readonly trackedProcessPids: ReadonlyArray<number>;
  readonly containers: ReadonlyArray<string>;
}

export interface LeakArtifacts {
  readonly stateDirs: ReadonlyArray<string>;
  readonly socketPaths: ReadonlyArray<string>;
  readonly states: ReadonlyArray<StackState>;
  readonly tempDataDirs: ReadonlyArray<string>;
  readonly trackedProcessPids: ReadonlyArray<number>;
  readonly containers: ReadonlyArray<string>;
}

const parseLines = (text: string): Array<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const diffList = <A>(before: ReadonlyArray<A>, after: ReadonlyArray<A>): Array<A> => {
  const seen = new Set(before);
  return after.filter((value) => !seen.has(value));
};

function readStackStateDir(homeDir: string): {
  readonly stateDirs: Array<string>;
  readonly socketPaths: Array<string>;
  readonly states: Array<StackState>;
} {
  const stacksRoot = path.join(homeDir, ".supabase", "stacks");
  if (!existsSync(stacksRoot)) {
    return { stateDirs: [], socketPaths: [], states: [] };
  }

  const stateDirs: Array<string> = [];
  const socketPaths: Array<string> = [];
  const states: Array<StackState> = [];

  for (const entry of readdirSync(stacksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(stacksRoot, entry.name);
    const statePath = path.join(dir, "state.json");
    const socketPath = path.join(dir, "daemon.sock");

    stateDirs.push(dir);

    if (existsSync(socketPath)) {
      socketPaths.push(socketPath);
    }

    if (!existsSync(statePath)) {
      continue;
    }

    try {
      states.push(JSON.parse(readFileSync(statePath, "utf8")) as StackState);
    } catch {
      // Ignore partially written state files during leak scans.
    }
  }

  return { stateDirs, socketPaths, states };
}

function listTempDataDirs(): Array<string> {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("supabase-local-"))
    .map((entry) => path.join(tmpdir(), entry.name))
    .sort();
}

function listTrackedProcessPids(needles: ReadonlyArray<string>): Array<number> {
  const activeNeedles = needles.filter((needle) => needle.length > 0);
  if (activeNeedles.length === 0) {
    return [];
  }

  try {
    const output = execFileSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return parseLines(output)
      .map((line): readonly [number, string] | undefined => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match?.[1] != null ? [Number.parseInt(match[1], 10), match[2] ?? ""] : undefined;
      })
      .filter((entry): entry is readonly [number, string] => entry != null)
      .filter(
        ([pid, command]) => pid > 0 && activeNeedles.some((needle) => command.includes(needle)),
      )
      .map(([pid]) => pid)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function listContainers(apiPort?: number): Array<string> {
  if (apiPort == null) {
    return [];
  }

  try {
    const output = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    return parseLines(output)
      .filter((name) => name.startsWith("supabase-") && name.endsWith(`-${apiPort}`))
      .sort();
  } catch {
    return [];
  }
}

export function takeLeakSnapshot(opts: {
  readonly homeDir: string;
  readonly apiPort?: number;
  readonly processNeedles?: ReadonlyArray<string>;
}): LeakSnapshot {
  const { stateDirs, socketPaths, states } = readStackStateDir(opts.homeDir);

  return {
    stateDirs,
    socketPaths,
    states,
    tempDataDirs: listTempDataDirs(),
    trackedProcessPids: listTrackedProcessPids(opts.processNeedles ?? []),
    containers: listContainers(opts.apiPort),
  };
}

export function diffLeakArtifacts(before: LeakSnapshot, after: LeakSnapshot): LeakArtifacts {
  const beforeStateJson = new Set(before.states.map((state) => JSON.stringify(state)));

  return {
    stateDirs: diffList(before.stateDirs, after.stateDirs),
    socketPaths: diffList(before.socketPaths, after.socketPaths),
    states: after.states.filter((state) => !beforeStateJson.has(JSON.stringify(state))),
    tempDataDirs: diffList(before.tempDataDirs, after.tempDataDirs),
    trackedProcessPids: diffList(before.trackedProcessPids, after.trackedProcessPids),
    containers: diffList(before.containers, after.containers),
  };
}

export function cleanupLeakArtifacts(artifacts: LeakArtifacts): void {
  for (const state of artifacts.states) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {}
  }

  for (const pid of artifacts.trackedProcessPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  for (const container of artifacts.containers) {
    try {
      execFileSync("docker", ["rm", "-f", container], {
        stdio: "ignore",
        timeout: 5_000,
      });
    } catch {}
  }

  for (const target of [...artifacts.stateDirs, ...artifacts.tempDataDirs]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {}
  }

  for (const socketPath of artifacts.socketPaths) {
    try {
      rmSync(socketPath, { force: true });
    } catch {}
  }
}

export async function waitForLeakSnapshot(
  read: () => LeakSnapshot,
  predicate: (snapshot: LeakSnapshot) => boolean,
  opts: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<LeakSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const snapshot = read();
    if (predicate(snapshot) || Date.now() >= deadline) {
      return snapshot;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
