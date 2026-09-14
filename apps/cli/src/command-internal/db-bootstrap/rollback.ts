import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { ContainerIdName } from "../docker-lifecycle.ts";
import { dockerRemoveAll } from "../docker-remove-all.ts";
import { cleanupStartSecrets } from "../start-secrets-cleanup.ts";
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
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    // `dockerRemoveAll` doesn't print this; each caller owns its own status writer.
    yield* Effect.sync(() => {
      globalThis.process.stderr.write("Stopping containers...\n");
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
          globalThis.process.stderr.write(`${error.message}\n`);
        }),
      ),
    );
    yield* cleanupStartSecrets(removedContainers, workdir);
  });
