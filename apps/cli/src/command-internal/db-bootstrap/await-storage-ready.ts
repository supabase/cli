/**
 * Gate that `db reset` runs before seeding storage buckets: skips seeding when the storage
 * container is absent, and blocks on it becoming healthy otherwise.
 *
 * Any inspect error (not just "container not found") is treated as "absent". A container that
 * exists but is unhealthy triggers a real wait, and a timeout there fails the whole reset rather
 * than just skipping buckets.
 */

import { Effect, Result } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { inspectContainerState } from "../docker-lifecycle.ts";
import { serviceContainerName } from "../docker-ids.ts";
import { waitForHealthyServices, type HealthCheckTimeoutError } from "./health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Independent of `db.health_timeout`; storage bucket seeding always waits up to this long. */
const AWAIT_STORAGE_READY_TIMEOUT_SECONDS = 30;

/**
 * Resolves `true` when the storage container exists, `false` when it does not (including any
 * inspect error, not just "not found").
 *
 * @throws {@link HealthCheckTimeoutError} if storage exists but never becomes healthy within
 * {@link AWAIT_STORAGE_READY_TIMEOUT_SECONDS}; that failure propagates rather than resolving to
 * `false`.
 */
export function awaitStorageReady(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<boolean, HealthCheckTimeoutError, HttpClient.HttpClient> {
  const storageId = serviceContainerName("storage", projectId);
  return Effect.gen(function* () {
    const inspected = yield* inspectContainerState(spawner, storageId).pipe(Effect.result);
    if (Result.isFailure(inspected)) return false;
    if (inspected.success.health === "healthy") return true;
    yield* waitForHealthyServices(spawner, [storageId], {
      timeoutSeconds: AWAIT_STORAGE_READY_TIMEOUT_SECONDS,
    });
    return true;
  });
}
