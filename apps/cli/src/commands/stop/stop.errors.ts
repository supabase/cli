import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. The explicit workdir is `chdir`'d into unconditionally before
 * `stop`'s own flag validation or handler body, so a bad explicit workdir must
 * fail here first, before config load or any Docker access.
 */
export class StopWorkdirError extends Data.TaggedError("StopWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `--project-id` and `--all` were both set. */
export class StopMutuallyExclusiveError extends Data.TaggedError("StopMutuallyExclusiveError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** Loading `config.toml` failed for a reason other than the file being absent (malformed TOML). */
export class StopConfigLoadError extends Data.TaggedError("StopConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Listing containers to stop failed; wraps `DockerLifecycleListError` (see `docker-lifecycle.ts`). */
export class StopListError extends Data.TaggedError("StopListError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** Stopping one or more containers failed (`DockerRemoveAll`'s `WaitAll` step). */
export class StopContainerError extends Data.TaggedError("StopContainerError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker container prune` failed. */
export class StopContainerPruneError extends Data.TaggedError("StopContainerPruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker volume prune` failed (only run when `--no-backup`/`--backup=false`). */
export class StopVolumePruneError extends Data.TaggedError("StopVolumePruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/** `docker network prune` failed. */
export class StopNetworkPruneError extends Data.TaggedError("StopNetworkPruneError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}
