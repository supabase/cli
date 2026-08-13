/**
 * Port of the storage-health gate `Run` runs inline before seeding buckets — not a
 * standalone Go function despite the name here (`apps/cli-go/internal/db/reset/
 * reset.go:66-71`). Two things the seam this replaces got subtly wrong, corrected
 * here:
 *
 * 1. `resp, err := utils.Docker.ContainerInspect(ctx, utils.StorageId); if err != nil {
 *    return false, nil }` — ANY inspect error (not just "not found") maps to "absent"
 *    (`false`), matching Go exactly (`errdefs.IsNotFound` is never checked on this
 *    particular path).
 * 2. `if resp.State.Health == nil || resp.State.Health.Status != types.Healthy { if err
 *    := start.WaitForHealthyService(ctx, 30*time.Second, utils.StorageId); err != nil {
 *    return false, err } }` — a container that EXISTS but is unhealthy (or has no
 *    healthcheck at all) triggers a real 30-SECOND wait, hardcoded independent of
 *    `db.health_timeout`; if that wait times out, the failure propagates and FAILS THE
 *    WHOLE RESET (not just "skip buckets") — dumping the storage container's logs to
 *    stderr on the way out, via `legacyWaitForHealthyServices`'s own existing behavior.
 *
 * Hoisted to `legacy/shared/db-bootstrap/` (CLI-2062): originally lived in
 * `commands/db/reset/` since `db reset`'s own handler was its only caller — the
 * bucket-seeding health gate has no equivalent in `db start`/`supabase start` at
 * all (CLI-1955 review follow-up). `legacyResetLocalDatabase`
 * (`reset-local-database.ts`) is now a second caller (`db schema declarative`'s
 * smart-target/sync recovery reset), so this moved alongside it.
 */

import { Effect, Result } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyInspectContainerState } from "../legacy-docker-lifecycle.ts";
import { legacyServiceContainerName } from "../legacy-docker-ids.ts";
import {
  legacyWaitForHealthyServices,
  type LegacyHealthCheckTimeoutError,
} from "./health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

/** Go's hardcoded `30*time.Second` (`reset.go:68`) — independent of `db.health_timeout`. */
const LEGACY_AWAIT_STORAGE_READY_TIMEOUT_SECONDS = 30;

/**
 * Resolves `true` when the storage container exists (so the caller should run the
 * ported bucket-seeding core) and `false` when it does not (any inspect error) —
 * matching Go, which silently skips buckets when storage is absent. Fails with
 * {@link LegacyHealthCheckTimeoutError} when storage exists but never becomes healthy
 * within 30 seconds — this is NOT swallowed into `false`, matching Go's own
 * `return false, err` propagating the wait's error to the caller, which fails the
 * entire reset.
 */
export function legacyAwaitStorageReady(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<boolean, LegacyHealthCheckTimeoutError, HttpClient.HttpClient> {
  const storageId = legacyServiceContainerName("storage", projectId);
  return Effect.gen(function* () {
    const inspected = yield* legacyInspectContainerState(spawner, storageId).pipe(Effect.result);
    if (Result.isFailure(inspected)) return false;
    if (inspected.success.health === "healthy") return true;
    yield* legacyWaitForHealthyServices(spawner, [storageId], {
      timeoutSeconds: LEGACY_AWAIT_STORAGE_READY_TIMEOUT_SECONDS,
    });
    return true;
  });
}
