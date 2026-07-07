import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
 * how (in phase 1, `@supabase/stack`'s `createStack`, which — like
 * process-compose's `detached: true` children — does not run postgres as a
 * child of the fleet daemon's own process group).
 *
 * Phase 1 only ever runs postgres under a fleet pod (postgres-only ready
 * gate; no HTTP edge / other services yet), so postmaster.pid alone is a
 * complete picture of "is anything from this pod still alive" — no need to
 * separately reap other service processes.
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

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 5000).unref();
}
