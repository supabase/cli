import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import { legacyCleanupStartSecrets } from "../../shared/legacy-start-secrets-cleanup.ts";
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
 *
 * Also reclaims any {@link legacyCleanupStartSecrets} staged-secret
 * directories for the containers this run created — a TS-port-only hygiene
 * step with no Go equivalent (see that function's doc comment). The matching
 * container names come from {@link legacyDockerRemoveAll}'s own
 * `onContainersListed` hook, captured BEFORE teardown from that function's
 * single internal `docker ps` listing — never a second, separately listed
 * call, which would cost an extra real Docker Engine API request Go never
 * makes (see that function's doc comment for the parity rationale).
 */
export const legacyRollbackStart = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
  workdir: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    let containerNames: ReadonlyArray<string> = [];
    yield* legacyDockerRemoveAll(spawner, filterValue, deleteVolumes, (containers) => {
      containerNames = containers.map((container) => container.name);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          globalThis.process.stderr.write(`${error.message}\n`);
        }),
      ),
    );
    yield* legacyCleanupStartSecrets(workdir, containerNames);
  });
