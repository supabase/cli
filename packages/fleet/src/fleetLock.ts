import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface FleetLock {
  release(): Promise<void>;
}

/**
 * Fleet-wide single-owner lock: a pid file at the fleet root.
 *
 * The whole fleet design assumes exactly one daemon per root (PortRegistry has
 * no cross-process coordination, and startup reconciliation KILLS any
 * postmaster it finds under a pod dir — including ones a live sibling daemon
 * owns). Acquiring this lock before touching any pod state turns "second
 * daemon reaps the first daemon's warm pods, then dies on EADDRINUSE" into an
 * immediate, explicit startup error.
 *
 * A lock whose recorded pid is no longer alive is stale (previous daemon
 * crashed) and is taken over. The post-acquire read-back closes most of the
 * window where two starters could both observe the same stale lock, unlink
 * it, and race the re-create.
 */
export async function acquireFleetLock(lockPath: string): Promise<FleetLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const raw = await readFile(lockPath, "utf8").catch(() => undefined);
      const ownerPid = Number(raw?.trim());
      // A live owner blocks acquisition even when it's this very process:
      // two fleets in one process on the same root are still two daemons.
      if (Number.isFinite(ownerPid) && ownerPid > 0 && isAlive(ownerPid)) {
        throw new Error(
          `another fleet daemon (pid ${ownerPid}) already owns this fleet root; refusing to start a second one against ${lockPath}`,
        );
      }
      await unlink(lockPath).catch(() => {});
      continue;
    }
    const written = await readFile(lockPath, "utf8").catch(() => undefined);
    if (written?.trim() !== String(process.pid)) continue; // lost a takeover race
    return {
      async release() {
        const owner = await readFile(lockPath, "utf8").catch(() => undefined);
        if (owner?.trim() === String(process.pid)) {
          await unlink(lockPath).catch(() => {});
        }
      },
    };
  }
  throw new Error(`could not acquire the fleet lock at ${lockPath}`);
}
