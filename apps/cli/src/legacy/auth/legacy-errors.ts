import { Data } from "effect";

export class LegacyInvalidAccessTokenError extends Data.TaggedError(
  "LegacyInvalidAccessTokenError",
)<{
  readonly message: string;
}> {}

export class LegacyPlatformAuthRequiredError extends Data.TaggedError(
  "LegacyPlatformAuthRequiredError",
)<{
  readonly message: string;
}> {}

/**
 * Raised by `deleteProjectCredential` when removing a stored database-password
 * credential from the OS keyring fails for a reason other than "entry not
 * found" (which is ignored). Mirrors `supabase unlink`'s behaviour of collecting
 * non-`ErrNotFound` / non-`ErrNotSupported` keyring errors
 * (`apps/cli-go/internal/unlink/unlink.go:36-40`).
 */
export class LegacyCredentialDeleteError extends Data.TaggedError("LegacyCredentialDeleteError")<{
  readonly message: string;
}> {}

/**
 * Raised by `deleteAccessToken` when there is no access token to delete, i.e.
 * the profile keyring entry is absent or the keyring backend is unavailable
 * (WSL / `SUPABASE_NO_KEYRING` / unsupported platform). Mirrors Go's
 * `utils.ErrNotLoggedIn` (`apps/cli-go/internal/utils/access_token.go:19`),
 * which `supabase logout` surfaces as `You were not logged in, nothing to do.`
 * on stderr while still exiting 0.
 */
export class LegacyNotLoggedInError extends Data.TaggedError("LegacyNotLoggedInError")<{
  readonly message: string;
}> {}

/**
 * Raised by `deleteAccessToken` when removing the token fails for a real reason
 * — a non-`ENOENT` failure removing `<SUPABASE_HOME or ~/.supabase>/access-token`, or a non
 * not-found error deleting the profile keyring entry. Mirrors Go's
 * `failed to remove access token file: …` / `failed to delete access token from
 * keyring: …` errors (`access_token.go:100-119`), which exit 1.
 */
export class LegacyDeleteTokenError extends Data.TaggedError("LegacyDeleteTokenError")<{
  readonly message: string;
}> {}
