import { Data } from "effect";

/** `loadProjectConfig` rejected `supabase/config.toml` (malformed TOML/JSON). */
export class LegacyStatusConfigLoadError extends Data.TaggedError("LegacyStatusConfigLoadError")<{
  readonly message: string;
}> {}

/** A `--override-name KEY=VALUE` entry did not parse, mirroring `env.EnvironToEnvSet`. */
export class LegacyStatusOverrideParseError extends Data.TaggedError(
  "LegacyStatusOverrideParseError",
)<{
  readonly message: string;
}> {}

/** Inspecting the db container failed for a reason other than "not found". */
export class LegacyStatusDbInspectError extends Data.TaggedError("LegacyStatusDbInspectError")<{
  readonly message: string;
}> {}

/** The db container is absent or present but not in the `running` state. */
export class LegacyStatusDbNotRunningError extends Data.TaggedError(
  "LegacyStatusDbNotRunningError",
)<{
  readonly message: string;
}> {}

/** The db container is running but its Docker health check is not `healthy`. */
export class LegacyStatusDbNotReadyError extends Data.TaggedError("LegacyStatusDbNotReadyError")<{
  readonly message: string;
}> {}

/** Listing running containers by label failed. */
export class LegacyStatusListError extends Data.TaggedError("LegacyStatusListError")<{
  readonly message: string;
}> {}
