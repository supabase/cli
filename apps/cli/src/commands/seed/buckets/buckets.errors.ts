import { Data } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";

/**
 * Domain errors specific to `supabase seed buckets`.
 *
 * The Storage gateway and credential-derivation errors are shared with
 * `storage ls/cp/mv/rm` and live in `command-internal/storage-gateway.errors.ts`
 * and `command-internal/storage-credentials.errors.ts`. This file keeps only
 * the seed-specific errors.
 */

/**
 * Raised when `supabase/config.toml` cannot be parsed, or a config-load-time
 * validation Go runs before any Storage call fails (bucket name regex,
 * `file_size_limit` numeral). Mirrors the `config push` CLI-1489 tradeoff:
 * `loadCliConfig` raises `CliConfigParseError` on `env(...)` refs over
 * numeric/bool fields, which Go resolves transparently.
 */
export class SeedConfigLoadError extends Data.TaggedError("SeedConfigLoadError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/**
 * Raised when `--local` and `--linked` are both passed, reproducing cobra's
 * `MarkFlagsMutuallyExclusive("local", "linked")`.
 */
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
 * directory (`validateWorkdirIsDirectory`). Only reachable when the
 * user explicitly set it — beats the `--project-ref` guard and every
 * network call.
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
 * raised instead of silently falling back to the embedded default (empty)
 * bucket configuration, which would authenticate and seed nothing while
 * still exiting 0.
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
