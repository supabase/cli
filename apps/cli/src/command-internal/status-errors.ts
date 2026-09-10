import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a directory. Checked
 * before config load or any Docker access.
 */
export class StatusWorkdirError extends Data.TaggedError("StatusWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/** `loadCliConfig` rejected `supabase/config.toml` (malformed TOML/JSON). */
export class StatusConfigLoadError extends Data.TaggedError("StatusConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A `--override-name KEY=VALUE` entry did not parse. */
export class StatusOverrideParseError extends Data.TaggedError("StatusOverrideParseError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Inspecting the db container failed for a reason other than "not found" — but since an
 * absent container is just another non-zero inspect exit, the dominant real trigger is that
 * the local stack was never started, same as {@link StatusDbNotRunningError}.
 */
export class StatusDbInspectError extends Data.TaggedError("StatusDbInspectError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** The db container is absent or present but not in the `running` state. */
export class StatusDbNotRunningError extends Data.TaggedError("StatusDbNotRunningError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** The db container is running but its Docker health check is not `healthy`. */
export class StatusDbNotReadyError extends Data.TaggedError("StatusDbNotReadyError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** Listing running containers by label failed. */
export class StatusListError extends Data.TaggedError("StatusListError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.dockerNotRunning;
  }
}

/**
 * `config.toml` resolved to a value validation would reject before status ever renders —
 * e.g. an `auth.jwt_secret` shorter than 16 characters.
 */
export class StatusInvalidConfigError extends Data.TaggedError("StatusInvalidConfigError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}
