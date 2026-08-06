import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import type { LegacyContainerIdName } from "../../shared/legacy-docker-lifecycle.ts";
import { legacyDockerRemoveAll } from "../../shared/legacy-docker-remove-all.ts";
import { legacyCleanupStartSecrets } from "../../shared/legacy-start-secrets-cleanup.ts";
import { LegacyHealthCheckTimeoutError } from "./lib/health-check.ts";

type Spawner = ChildProcessSpawner["Service"];

// Below, a bare `start.go:NNN` means the deleted, unreachable
// `internal/start/start.go` (CLI-1966; last present at commit
// a253ccba25c21356ccd33044c4474aecb77d1ae4) unless prefixed `internal/db/start/`,
// which is still live -- see `SIDE_EFFECTS.md`.

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
 * INTENTIONAL DIVERGENCE (CLI-1987, ruled 2026-07-30): Go applies
 * `IsUnhealthyError` ONCE, at the outer `Run()` boundary, to whatever `run()`
 * returns (`internal/start/start.go:74-75`) — and the shape-based check
 * accidentally also matches `ensureImagesCached`'s `errors.Join(result...)`
 * (`internal/start/start.go:257-260`). Under `--ignore-health-check`, Go
 * therefore swallows a total image-pull failure (or a Docker daemon that
 * becomes unreachable during the pre-pull): it prints the error, skips
 * rollback, prints `Started supabase local development setup.` + the status
 * table + the security notice, and exits 0 with no container running. That is
 * an unintended quirk of the shape check, not designed behaviour — Go's own
 * comment on `IsUnhealthyError` reads "Health check always returns a
 * joinError". Per the CLI-1987 ruling, this port deliberately does NOT
 * reproduce the quirk — and what enforces that is control flow, not this
 * matcher: the port has no outer classifier check. `start.handler.ts`
 * consults this function only inside its two health-wait failure branches,
 * and the pre-pull (`legacyEnsureImagesCached`) runs before bring-up, so a
 * `LegacyImagePrepullError` (`lib/image-prepull.ts`) propagates straight out
 * and always fails the command with exit 1, with or without the flag.
 * Widening this match to accept `LegacyImagePrepullError` would be a dead
 * no-op — no pre-pull failure ever reaches a call site. The observable delta
 * vs Go's swallowed path is exit code + success banner + status table +
 * security notice (Go prints all of the latter three unconditionally at
 * `Run()`'s tail, `start.go:84-87`; this port's failure exits before any of
 * them). Rollback is not part of the divergence — the pre-pull runs before
 * any container/network is created, so there is nothing to roll back in
 * either CLI. Do not "fix" this toward Go by gating the pre-pull on
 * `--ignore-health-check` or by reintroducing an outer shape check on the
 * whole handler result.
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
  debug: boolean,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    // Go's `DockerRemoveAll` prints "Stopping containers..." to the writer its
    // caller passes (`internal/utils/docker.go:97`); the start-failure path
    // passes `os.Stderr` (`internal/start/start.go:77`). The TS port moved that
    // line out of `legacyDockerRemoveAll` and into each caller (`stop` prints
    // it to its own status writer), so the rollback path prints it here.
    yield* Effect.sync(() => {
      globalThis.process.stderr.write("Stopping containers...\n");
    });
    let removedContainers: ReadonlyArray<LegacyContainerIdName> = [];
    yield* legacyDockerRemoveAll(
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
    yield* legacyCleanupStartSecrets(removedContainers, workdir);
  });
