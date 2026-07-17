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

function commandStderr(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const stderr = error.stderr;
  if (typeof stderr === "string") return stderr;
  if (stderr instanceof Uint8Array) return new TextDecoder().decode(stderr);
  return "";
}

function dockerForceRemoveStrict(containerNames: ReadonlyArray<string>): void {
  const errors: unknown[] = [];
  for (const name of containerNames) {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "pipe", timeout: 5_000 });
    } catch (error) {
      if (commandStderr(error).includes("No such container")) continue;
      errors.push(new Error(`Failed to remove Docker container ${name}`, { cause: error }));
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to remove Stack Docker containers");
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

    const remaining = cleanupTargets
      .filter((target) => existsSync(target.path))
      .map((target) => target.path);
    if (remaining.length > 0) {
      throw new Error(`Failed to remove Stack runtime paths: ${remaining.join(", ")}`);
    }
  });

export const cleanupLocalStackResources = (opts: {
  readonly stop: () => Effect.Effect<void>;
  readonly cleanupTargets: CleanupTargets;
  readonly config: ResolvedStackConfig;
}): Effect.Effect<void> =>
  // All cleanup stages run even when an earlier stage fails. `ensuring`
  // preserves the combined failure cause, so callers never receive a false
  // success while a service, container, or runtime directory may remain.
  Effect.uninterruptible(opts.stop()).pipe(
    Effect.ensuring(
      Effect.sync(() => dockerForceRemoveStrict(opts.cleanupTargets.dockerContainerNames)).pipe(
        Effect.ensuring(cleanupAutoManagedPathsWithRetry(opts.config)),
      ),
    ),
  );
