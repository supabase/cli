import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { Duration, Effect } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import type { ResolvedStackConfig } from "./StackBuilder.ts";

/**
 * Force-remove Docker containers by name. Best-effort safety net —
 * silently ignores containers that don't exist or are already removed.
 */
export function dockerForceRemove(containerNames: ReadonlyArray<string>): void {
  for (const name of containerNames) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 5_000 });
    } catch {}
  }
}

export function cleanupAutoManagedPaths(config: ResolvedStackConfig): void {
  if (config.autoManagedPaths.length === 0) {
    return;
  }

  for (const dir of config.autoManagedPaths) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — temp dir will be cleaned by OS eventually.
    }
  }

  try {
    rmSync(`${config.postgres.dataDir}_pg_hba_docker.conf`, { force: true });
  } catch {}
}

const cleanupAutoManagedPathsWithRetry = (config: ResolvedStackConfig): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (config.autoManagedPaths.length === 0) {
      return;
    }

    const cleanupTargets = [
      ...config.autoManagedPaths.map((path) => ({ path, recursive: true as const })),
      { path: `${config.postgres.dataDir}_pg_hba_docker.conf`, recursive: false as const },
    ];

    for (let attempt = 0; attempt < 80; attempt++) {
      yield* Effect.sync(() => {
        for (const target of cleanupTargets) {
          try {
            rmSync(target.path, { recursive: target.recursive, force: true });
          } catch {}
        }
      });

      if (cleanupTargets.every((target) => !existsSync(target.path))) {
        return;
      }

      yield* Effect.sleep(Duration.millis(250));
    }
  });

export const cleanupLocalStackResources = (opts: {
  readonly stop: () => Effect.Effect<void>;
  readonly cleanupTargets: CleanupTargets;
  readonly config: ResolvedStackConfig;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Best-effort graceful shutdown — stop() may fail if services already
    // exited or the scope is partially closed. Make the stop path
    // uninterruptible so SIGTERM-driven scope closure does not abandon it
    // mid-shutdown and leak child processes.
    yield* Effect.uninterruptible(opts.stop()).pipe(Effect.catch(() => Effect.void));

    // Safety net: force-remove any Docker containers that survived
    // signal-based shutdown. On macOS, killing the `docker run` client
    // may not stop the container.
    yield* Effect.sync(() => {
      dockerForceRemove(opts.cleanupTargets.dockerContainerNames);
    });
    yield* cleanupAutoManagedPathsWithRetry(opts.config);
  });
