import { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

import { isContainerNotFoundMessage } from "../container-cli.ts";
import type { ContainerIdName } from "../docker-lifecycle.ts";
import { dockerRemoveAll, pruneProjectNetworks } from "../docker-remove-all.ts";
import { cleanupStartSecrets } from "../start-secrets-cleanup.ts";
import { isVolumeNotFoundMessage, removeContainer, removeVolume } from "./container-lifecycle.ts";
import { HealthCheckTimeoutError } from "./health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Matches only {@link HealthCheckTimeoutError}, not any pre-pull failure. The caller consults
 * this only inside its health-wait failure branches, so `--ignore-health-check` never downgrades
 * an `ImagePrepullError` — pre-pull failures always exit 1. Do not widen this to a general
 * unhealthy-shape check or gate the pre-pull on the flag.
 */
export function isUnhealthyStartError(error: unknown): error is HealthCheckTimeoutError {
  return error instanceof HealthCheckTimeoutError;
}

/**
 * Tears down every container/volume/network the failed run created (by project label) via
 * {@link dockerRemoveAll}, and reclaims this run's staged-secret directories via
 * {@link cleanupStartSecrets}. A rollback failure is only logged to stderr, never propagated —
 * it must not mask the original failure that triggered the rollback.
 */
export const rollbackStart = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
  workdir: string,
  debug: boolean,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // `dockerRemoveAll` doesn't print this; each caller owns its own status writer.
    yield* Effect.sync(() => {
      process.stderr.write("Stopping containers...\n");
    });
    let removedContainers: ReadonlyArray<ContainerIdName> = [];
    yield* dockerRemoveAll(
      spawner,
      filterValue,
      deleteVolumes,
      (containers) => {
        removedContainers = containers;
      },
      debug,
    ).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
        }),
      ),
    );
    yield* Effect.annotateCurrentSpan("container.removed_count", removedContainers.length);
    yield* cleanupStartSecrets(removedContainers, workdir);
  }).pipe(
    Effect.withSpan("DbBootstrap.rollbackStart", {
      attributes: { "rollback.delete_volumes": deleteVolumes },
    }),
  );

const writeStderrLine = (message: string) =>
  Effect.sync(() => {
    process.stderr.write(`${message}\n`);
  });

/** Resolves whether the resource is gone; a missing resource counts, any other failure is logged. */
const removeLoggingFailure = <E extends { readonly message: string }>(
  remove: Effect.Effect<void, E>,
  isMissing: (message: string) => boolean,
) =>
  remove.pipe(
    Effect.catchIf(
      (error) => isMissing(error.message),
      () => Effect.void,
    ),
    Effect.as(true),
    Effect.catch((error) => writeStderrLine(error.message).pipe(Effect.as(false))),
  );

/**
 * `db start`'s rollback: removes only the db container, its volume when `deleteVolume`, and the
 * project's unused networks, so the project's other services and volumes survive a failed run.
 * A rollback failure is only logged to stderr, never propagated.
 */
export const rollbackDatabaseStart = (
  spawner: Spawner,
  filterValue: string,
  dbContainerId: string,
  deleteVolume: boolean,
  debug: boolean,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* writeStderrLine("Stopping containers...");

    const containerRemoved = yield* removeLoggingFailure(
      removeContainer(spawner, dbContainerId),
      isContainerNotFoundMessage,
    );
    yield* Effect.annotateCurrentSpan("container.removed", containerRemoved);

    if (deleteVolume) {
      const volumeRemoved = yield* removeLoggingFailure(
        removeVolume(spawner, dbContainerId),
        isVolumeNotFoundMessage,
      );
      yield* Effect.annotateCurrentSpan("volume.removed", volumeRemoved);
    }

    yield* pruneProjectNetworks(spawner, filterValue, debug).pipe(
      Effect.catch((error) => writeStderrLine(error.message)),
    );
  }).pipe(
    Effect.withSpan("DbBootstrap.rollbackDatabaseStart", {
      attributes: { "rollback.delete_volumes": deleteVolume },
    }),
  );
