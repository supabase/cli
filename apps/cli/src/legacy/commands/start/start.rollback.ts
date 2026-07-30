import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { LegacyContainerIdName } from "../../shared/legacy-docker-lifecycle.ts";
import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import { legacyCleanupStartSecrets } from "../../shared/legacy-start-secrets-cleanup.ts";
import { LegacyHealthCheckTimeoutError } from "./lib/health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

/**
 * Port of Go's `start.IsUnhealthyError` (`apps/cli-go/internal/db/start/
 * start.go:227-231`): Go tests whether the failure unwraps as a joined
 * multi-error (`Unwrap() []error`) — the shape `WaitForHealthyService`
 * produces on timeout. This port's equivalent health-check-timeout failure is
 * {@link LegacyHealthCheckTimeoutError} (`lib/health-check.ts`), so the
 * classification collapses to an `instanceof` check against that one class —
 * the caller (`start.handler.ts`) uses this to decide whether
 * `--ignore-health-check` should downgrade a failure to a warning instead of
 * triggering rollback + a hard exit.
 *
 * INTENTIONAL DIVERGENCE (CLI-1987, ruled 2026-07-30): Go's shape-based check
 * accidentally also matches `ensureImagesCached`'s `errors.Join(result...)`
 * (`internal/start/start.go:257-260`) — under `--ignore-health-check`, Go
 * therefore swallows a total image-pull failure (or a Docker daemon that
 * becomes unreachable during the pre-pull): it prints the error, skips
 * rollback, prints `Started supabase local development setup.` + the status
 * table + the security notice, and exits 0 with no container running. That is
 * an unintended quirk of the shape check, not designed behaviour — Go's own
 * comment on `IsUnhealthyError` reads "Health check always returns a
 * joinError". Per the CLI-1987 ruling, this port deliberately does NOT
 * reproduce the quirk: `LegacyImagePrepullError` (`lib/image-prepull.ts`) is
 * intentionally excluded from this match, so a pre-pull failure always fails
 * the command with exit 1 and no status table, with or without the flag.
 * (Rollback is not part of the divergence — the pre-pull runs before any
 * container/network is created, so there is nothing to roll back in either
 * CLI; the observable delta is exit code + banner + status table only.) Do
 * not "fix" this by widening the match toward Go's shape check.
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
 * containers come from {@link legacyDockerRemoveAll}'s own
 * `onContainersRemoved` hook, which fires only once `container prune` has
 * CONFIRMED they're actually gone — not merely listed, and not before the
 * stop/prune stages have run — from that function's single internal `docker
 * ps` listing, never a second, separately listed call, which would cost an
 * extra real Docker Engine API request Go never makes (see that function's
 * doc comment for the parity rationale). `workdir` (this run's own
 * `LegacyCliConfig.workdir`) is passed through only as
 * {@link legacyCleanupStartSecrets}'s fallback — every container this same
 * `start` run just created carries its own matching `LEGACY_CLI_WORKDIR_LABEL`
 * (see `container-lifecycle.ts`), so the fallback path is only ever exercised
 * by a container created before that label existed.
 */
export const legacyRollbackStart = (
  spawner: Spawner,
  filterValue: string,
  deleteVolumes: boolean,
  workdir: string,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    let removedContainers: ReadonlyArray<LegacyContainerIdName> = [];
    yield* legacyDockerRemoveAll(spawner, filterValue, deleteVolumes, (containers) => {
      removedContainers = containers;
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          globalThis.process.stderr.write(`${error.message}\n`);
        }),
      ),
    );
    yield* legacyCleanupStartSecrets(removedContainers, workdir);
  });
