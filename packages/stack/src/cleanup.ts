import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { Duration, Effect } from "effect";
import type { ResolvedStackConfig } from "./StackBuilder.ts";
import type { StackInfo, StackService } from "./Stack.ts";

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

export function cleanupAutoManagedDataDir(config: ResolvedStackConfig): void {
  if (!config.autoManagedDataDir) {
    return;
  }

  try {
    rmSync(config.postgres.dataDir, { recursive: true, force: true });
  } catch {
    // Best-effort — temp dir will be cleaned by OS eventually.
  }

  try {
    rmSync(`${config.postgres.dataDir}_pg_hba_docker.conf`, { force: true });
  } catch {
    // Best-effort — temp file will be cleaned by OS eventually.
  }
}

const cleanupAutoManagedDataDirWithRetry = (config: ResolvedStackConfig): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!config.autoManagedDataDir) {
      return;
    }

    const cleanupTargets = [
      { path: config.postgres.dataDir, recursive: true as const },
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
  readonly stack: Pick<StackService, "stop">;
  readonly info: StackInfo;
  readonly config: ResolvedStackConfig;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Best-effort graceful shutdown — stop() may fail if services already
    // exited or the scope is partially closed. Make the stop path
    // uninterruptible so SIGTERM-driven scope closure does not abandon it
    // mid-shutdown and leak child processes.
    yield* Effect.uninterruptible(opts.stack.stop()).pipe(Effect.catch(() => Effect.void));

    // Safety net: force-remove any Docker containers that survived
    // signal-based shutdown. On macOS, killing the `docker run` client
    // may not stop the container.
    yield* Effect.sync(() => {
      dockerForceRemove(opts.info.dockerContainerNames);
    });
    yield* cleanupAutoManagedDataDirWithRetry(opts.config);
  });
