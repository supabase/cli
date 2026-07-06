import { Data } from "effect";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. Mirrors Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:
 * 231-250`), which unconditionally `os.Chdir(workdir)`s in `PersistentPreRunE`
 * (`apps/cli-go/cmd/root.go:93-105`) — before `stop`'s own flag validation or
 * `RunE`, so a bad explicit workdir must fail here first, before config load
 * or any Docker access.
 */
export class LegacyStopWorkdirError extends Data.TaggedError("LegacyStopWorkdirError")<{
  readonly message: string;
}> {}

/**
 * `--project-id` and `--all` were both set. Best-effort match of cobra's
 * `MarkFlagsMutuallyExclusive` message shape (`stopCmd.MarkFlagsMutuallyExclusive("project-id",
 * "all")`, `apps/cli-go/cmd/stop.go`). Cobra isn't vendored in this repo, so the exact
 * wording could not be verified against source; this mirrors the same phrasing already
 * used for `gen types`'s mutually-exclusive flag groups (`types.handler.ts`).
 */
export class LegacyStopMutuallyExclusiveError extends Data.TaggedError(
  "LegacyStopMutuallyExclusiveError",
)<{
  readonly message: string;
}> {}

/** Loading `config.toml` failed for a reason other than the file being absent (malformed TOML). */
export class LegacyStopConfigLoadError extends Data.TaggedError("LegacyStopConfigLoadError")<{
  readonly message: string;
}> {}

/**
 * Listing containers to stop failed. `stop`-specific wrapper over
 * `LegacyDockerLifecycleListError` (see `legacy-docker-lifecycle.ts`) so this command's
 * errors are all in one file with a `LegacyStop*` tag, matching the plan's error list.
 */
export class LegacyStopListError extends Data.TaggedError("LegacyStopListError")<{
  readonly message: string;
}> {}

/** Stopping one or more containers failed (`DockerRemoveAll`'s `WaitAll` step). */
export class LegacyStopContainerError extends Data.TaggedError("LegacyStopContainerError")<{
  readonly message: string;
}> {}

/** `docker container prune` failed. */
export class LegacyStopContainerPruneError extends Data.TaggedError(
  "LegacyStopContainerPruneError",
)<{
  readonly message: string;
}> {}

/** `docker volume prune` failed (only run when `--no-backup`/`--backup=false`). */
export class LegacyStopVolumePruneError extends Data.TaggedError("LegacyStopVolumePruneError")<{
  readonly message: string;
}> {}

/** `docker network prune` failed. */
export class LegacyStopNetworkPruneError extends Data.TaggedError("LegacyStopNetworkPruneError")<{
  readonly message: string;
}> {}
