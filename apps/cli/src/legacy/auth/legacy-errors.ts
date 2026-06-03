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
