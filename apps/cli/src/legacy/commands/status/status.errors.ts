import { Data } from "effect";

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` path doesn't exist or isn't a
 * directory. Mirrors Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:
 * 231-250`), which unconditionally `os.Chdir(workdir)`s in `PersistentPreRunE`
 * (`apps/cli-go/cmd/root.go:93-105`) — before `status`'s own `PreRunE`
 * (override-name parsing) or `RunE`, so a bad explicit workdir must fail here
 * first, before config load or any Docker access.
 */
export class LegacyStatusWorkdirError extends Data.TaggedError("LegacyStatusWorkdirError")<{
  readonly message: string;
}> {}

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

/**
 * `config.toml` resolved to a value `Config.Validate` would reject before status
 * ever renders — e.g. an `auth.jwt_secret` shorter than 16 characters
 * (`pkg/config/apikeys.go:45-47`).
 */
export class LegacyStatusInvalidConfigError extends Data.TaggedError(
  "LegacyStatusInvalidConfigError",
)<{
  readonly message: string;
}> {}
