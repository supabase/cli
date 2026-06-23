import { Data } from "effect";

/**
 * Domain errors specific to `supabase seed buckets`.
 *
 * The Storage gateway and credential-derivation errors are shared with
 * `storage ls/cp/mv/rm` and live in `legacy/shared/legacy-storage-gateway.errors.ts`
 * and `legacy/shared/legacy-storage-credentials.errors.ts`. This file keeps only
 * the seed-specific errors.
 */

/**
 * Raised when `supabase/config.toml` cannot be parsed, or a config-load-time
 * validation Go runs before any Storage call fails (bucket name regex,
 * `file_size_limit` numeral). Mirrors the `config push` CLI-1489 tradeoff:
 * `loadProjectConfig` raises `ProjectConfigParseError` on `env(...)` refs over
 * numeric/bool fields, which Go resolves transparently.
 */
export class LegacySeedConfigLoadError extends Data.TaggedError("LegacySeedConfigLoadError")<{
  readonly message: string;
}> {}

/**
 * Raised when `--local` and `--linked` are both passed, reproducing cobra's
 * `MarkFlagsMutuallyExclusive("local", "linked")` (`apps/cli-go/cmd/seed.go:32`).
 */
export class LegacySeedMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacySeedMutuallyExclusiveFlagsError",
)<{
  readonly message: string;
}> {}
