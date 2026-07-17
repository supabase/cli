import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const TERM_TIMEOUT_MS = 5000;
const POLL_MS = 100;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function commandForPid(pid: number): Promise<string | undefined> {
  const procCmdline = await readFile(`/proc/${pid}/cmdline`, "utf8")
    .then((raw) => raw.split("\u0000").join(" ").trim())
    .catch(() => undefined);
  if (procCmdline !== undefined && procCmdline !== "") return procCmdline;

  return execFileAsync("ps", ["-p", String(pid), "-o", "command="])
    .then(({ stdout }) => stdout.trim())
    .catch(() => undefined);
}

async function isPostmasterForDataDir(pid: number, dataDir: string, raw: string): Promise<boolean> {
  const lines = raw.split("\n");
  const recordedDataDir = lines[1]?.trim();
  if (recordedDataDir === undefined || recordedDataDir === "") return false;

  const [actualDir, recordedDir] = await Promise.all([
    realpath(dataDir).catch(() => dataDir),
    realpath(recordedDataDir).catch(() => recordedDataDir),
  ]);
  if (actualDir !== recordedDir) return false;

  const command = await commandForPid(pid);
  return (
    command !== undefined &&
    command.includes("postgres") &&
    (command.includes(actualDir) || command.includes(recordedDataDir) || command.includes(dataDir))
  );
}

async function waitUntilExited(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (isAlive(pid)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

function signalPostmaster(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Reaps a stale postmaster (and its backends) left running under `dataDir`
 * by a previous, no-longer-live daemon process.
 *
 * Ground truth is postgres's own `<dataDir>/postmaster.pid`: its FIRST LINE
 * is the postmaster's pid. Unlike our `run.pid` marker (which records the
 * *daemon's* pid, not postgres's), the postmaster is always its own
 * process-group leader — its pgid equals its pid, and every backend it forks
 * shares that pgid. So `kill(-pid, ...)` reliably reaches the whole
 * postgres process tree for this data dir, regardless of what spawned it or
 * how (`@supabase/stack`'s `createStack`, like process-compose's
 * `detached: true` children, does not run postgres as a child of the fleet
 * daemon's own process group).
 *
 * This is a crash-recovery fallback for Postgres. Normal pod suspension asks
 * Stack to stop the complete service graph before checking that Postgres has
 * exited; orphaned sidecars remain covered by Stack's persisted cleanup
 * metadata rather than inferred from `postmaster.pid`.
 */
export async function reapStalePostmaster(dataDir: string): Promise<void> {
  const raw = await readFile(join(dataDir, "postmaster.pid"), "utf8").catch(() => undefined);
  if (raw === undefined) return;

  const firstLine = raw.split("\n")[0]?.trim();
  const pid = Number(firstLine);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;

  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) return;

  if (!(await isPostmasterForDataDir(pid, dataDir, raw))) return;

  signalPostmaster(pid, "SIGTERM");
  if (await waitUntilExited(pid, TERM_TIMEOUT_MS)) return;

  // Re-verify before escalating: the 5s grace period is exactly the window
  // where the postmaster may have exited on its own and the OS reused its
  // pid for an unrelated process — SIGKILLing that would be unrecoverable.
  if (!(await isPostmasterForDataDir(pid, dataDir, raw))) return;

  signalPostmaster(pid, "SIGKILL");
  if (await waitUntilExited(pid, TERM_TIMEOUT_MS)) return;
  if (await isPostmasterForDataDir(pid, dataDir, raw)) {
    throw new Error(`failed to terminate postgres process ${pid} for data directory ${dataDir}`);
  }
}
