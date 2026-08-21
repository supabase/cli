import { execFile } from "node:child_process";
import { Data, Duration, Effect, FileSystem, Schedule } from "effect";
import type { CleanupTargets } from "./CleanupTargets.ts";
import { SERVICE_NAMES, serviceMetadata } from "./ServiceCatalog.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import { dockerContainerName, stackIdentity } from "./StackIdentity.ts";

export const candidateCleanupTargets = (config: ResolvedStackConfig): CleanupTargets => {
  const identity = stackIdentity(config);
  return {
    dockerContainerNames: SERVICE_NAMES.filter((service) => {
      const serviceConfig = config[serviceMetadata(service).configKey];
      return service === "postgres" || serviceConfig !== false;
    }).map((service) => dockerContainerName(service, identity.key)),
  };
};

/**
 * Force-remove Docker containers by name. Best-effort safety net —
 * silently ignores containers that don't exist or are already removed.
 */
export const dockerForceRemove = (containerNames: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.forEach(
    containerNames,
    (name) =>
      Effect.callback<void>((resume) => {
        const child = execFile("docker", ["rm", "-f", name], { timeout: 5_000 }, () =>
          resume(Effect.void),
        );
        return Effect.sync(() => child.kill());
      }),
    { concurrency: 4, discard: true },
  );

class CleanupPending extends Data.TaggedError("CleanupPending")<{}> {}

const cleanupAutoManagedPathsWithRetry = (
  config: ResolvedStackConfig,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (config.autoManagedPaths.length === 0) {
      return;
    }

    const fs = yield* FileSystem.FileSystem;

    const cleanupTargets = [
      ...config.autoManagedPaths.map((path) => ({ path, recursive: true as const })),
      { path: `${config.postgres.dataDir}_pg_hba_docker.conf`, recursive: false as const },
    ];

    const attempt = Effect.gen(function* () {
      yield* Effect.forEach(
        cleanupTargets,
        (target) =>
          fs.remove(target.path, { recursive: target.recursive, force: true }).pipe(Effect.ignore),
        { concurrency: 4, discard: true },
      );
      const remaining = yield* Effect.forEach(
        cleanupTargets,
        (target) => fs.exists(target.path).pipe(Effect.catch(() => Effect.succeed(true))),
        { concurrency: 4 },
      );
      if (remaining.some(Boolean)) {
        return yield* Effect.fail(new CleanupPending());
      }
    });

    yield* attempt.pipe(
      Effect.retry(
        Schedule.recurs(79).pipe(Schedule.addDelay(() => Effect.succeed(Duration.millis(250)))),
      ),
      Effect.catch(() => Effect.void),
    );
  });

export const cleanupAutoManagedPaths = (
  config: ResolvedStackConfig,
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.uninterruptible(cleanupAutoManagedPathsWithRetry(config));

export const cleanupLocalStackResources = (opts: {
  readonly stop: () => Effect.Effect<void>;
  readonly cleanupTargets: CleanupTargets;
  readonly config: ResolvedStackConfig;
}): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    // Best-effort graceful shutdown — stop() may fail if services already
    // exited or the scope is partially closed. Make the stop path
    // uninterruptible so SIGTERM-driven scope closure does not abandon it
    // mid-shutdown and leak child processes.
    yield* Effect.uninterruptible(opts.stop()).pipe(Effect.catch(() => Effect.void));

    // Safety net: force-remove any Docker containers that survived
    // signal-based shutdown. On macOS, killing the `docker run` client
    // may not stop the container.
    yield* dockerForceRemove(opts.cleanupTargets.dockerContainerNames);
    yield* Effect.uninterruptible(cleanupAutoManagedPathsWithRetry(opts.config));
  });
