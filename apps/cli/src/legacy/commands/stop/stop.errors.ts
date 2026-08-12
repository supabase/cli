import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. The explicit workdir is `chdir`'d into unconditionally before
 * `stop`'s own flag validation or handler body, so a bad explicit workdir must
 * fail here first, before config load or any Docker access.
 */
export class LegacyStopWorkdirError extends Data.TaggedError("LegacyStopWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * `--project-id` and `--all` were both set. Matches the established
 * mutually-exclusive-flags message shape already
 * used for `gen types`'s mutually-exclusive flag groups (`types.handler.ts`).
 */
export class LegacyStopMutuallyExclusiveError extends Data.TaggedError(
  "LegacyStopMutuallyExclusiveError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Loading `config.toml` failed for a reason other than the file being absent (malformed TOML). */
export class LegacyStopConfigLoadError extends Data.TaggedError("LegacyStopConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Listing containers to stop failed. `stop`-specific wrapper over
 * `LegacyDockerLifecycleListError` (see `legacy-docker-lifecycle.ts`) so this command's
 * errors are all in one file with a `LegacyStop*` tag, matching the plan's error list.
 */
export class LegacyStopListError extends Data.TaggedError("LegacyStopListError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** Stopping one or more containers failed (`DockerRemoveAll`'s `WaitAll` step). */
export class LegacyStopContainerError extends Data.TaggedError("LegacyStopContainerError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker container prune` failed. */
export class LegacyStopContainerPruneError extends Data.TaggedError(
  "LegacyStopContainerPruneError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker volume prune` failed (only run when `--no-backup`/`--backup=false`). */
export class LegacyStopVolumePruneError extends Data.TaggedError("LegacyStopVolumePruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker network prune` failed. */
export class LegacyStopNetworkPruneError extends Data.TaggedError("LegacyStopNetworkPruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}
