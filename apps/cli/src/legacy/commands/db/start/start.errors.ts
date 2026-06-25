import { Data } from "effect";

/**
 * `supabase/config.toml` failed to parse. Go loads the config first thing in
 * `start.Run` (`flags.LoadConfig`, `internal/db/start/start.go:45`), so a
 * malformed config aborts before the container is touched.
 */
export class LegacyDbStartConfigLoadError extends Data.TaggedError("LegacyDbStartConfigLoadError")<{
  readonly message: string;
}> {}
