import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import { LegacyHealthCheckTimeoutError } from "./lib/health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Port of Go's `start.IsUnhealthyError` (`apps/cli-go/internal/db/start/
 * start.go:227-231`): Go tests whether the failure unwraps as a joined
 * multi-error, which is exactly the shape `WaitForHealthyService` produces on
 * timeout and nothing else in `run()` ever produces. This port's equivalent
 * "only the health-check timeout produces this shape" failure is
 * {@link LegacyHealthCheckTimeoutError} (`lib/health-check.ts`), so the
 * classification collapses to an `instanceof` check against that one class —
 * the caller (`start.handler.ts`) uses this to decide whether
 * `--ignore-health-check` should downgrade a failure to a warning instead of
 * triggering rollback + a hard exit.
 */
export function legacyIsUnhealthyStartError(
  error: unknown,
): error is LegacyHealthCheckTimeoutError {
  return error instanceof LegacyHealthCheckTimeoutError;
}

/**
 * Port of Go's rollback-on-failure step in `start.Run`
 * (`apps/cli-go/internal/start/start.go:76-81`):
 *
 * ```go
 * if err := utils.DockerRemoveAll(context.Background(), os.Stderr, utils.Config.ProjectId); err != nil {
 *   fmt.Fprintln(os.Stderr, err)
 * }
 * ```
 *
 * Tears down every container/volume/network the failed `start` run created
 * (by project label) via {@link legacyDockerRemoveAll}. A rollback failure is
 * itself only logged to stderr, never propagated — it must never mask the
 * original failure that triggered the rollback in the first place, matching
 * Go's `fmt.Fprintln(os.Stderr, err)` swallow exactly. `deleteVolumes` mirrors
 * Go's `utils.NoBackupVolume` global (set elsewhere, based on whether the
 * Postgres volume already existed before this run) — the caller decides its
 * value, this wrapper only forwards it to {@link legacyDockerRemoveAll}.
 */
export const legacyRollbackStart = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
): Effect.Effect<void, never> =>
  legacyDockerRemoveAll(spawner, filterValue, deleteVolumes).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        globalThis.process.stderr.write(`${error.message}\n`);
      }),
    ),
  );
