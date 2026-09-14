import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Domain errors specific to `supabase seed buckets`. Storage gateway and
 * credential-derivation errors are shared with `storage ls/cp/mv/rm` and live
 * in `command-internal/storage-*.errors.ts`.
 */

/**
 * Raised when `supabase/config.toml` cannot be parsed, or a config-load-time
 * validation fails before any Storage call (bucket name regex, `file_size_limit`
 * numeral), or by `loadCliConfig` for `env(...)` refs over numeric/bool fields.
 */
export class SeedConfigLoadError extends Data.TaggedError("SeedConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Raised when both `--local` and `--linked` are passed. */
export class SeedMutuallyExclusiveFlagsError extends Data.TaggedError(
  "SeedMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The resolved `--workdir`/`SUPABASE_WORKDIR` doesn't exist or isn't a
 * directory. Only reachable when explicitly set — beats the `--project-ref`
 * guard and every network call.
 */
export class SeedWorkdirError extends Data.TaggedError("SeedWorkdirError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * An explicit `--workdir`/`SUPABASE_WORKDIR` holds no project config —
 * raised instead of silently falling back to the embedded default, which
 * would authenticate and seed nothing while still exiting 0.
 */
export class SeedMissingProjectConfigError extends Data.TaggedError(
  "SeedMissingProjectConfigError",
)<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}
