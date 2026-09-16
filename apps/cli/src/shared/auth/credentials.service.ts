import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * Credentials - Boundary for loading and persisting the CLI access token.
 *
 * The implementation owns fallback policy between keyring-backed storage and the
 * filesystem so command handlers can treat token storage as one stable service.
 */
interface CredentialsShape {
  readonly getAccessToken: Effect.Effect<Option.Option<Redacted.Redacted<string>>, PlatformError>;
  readonly saveAccessToken: (
    token: string | Redacted.Redacted<string>,
  ) => Effect.Effect<void, PlatformError>;
  /** Deletes the stored access token from all locations. Returns true if a token was found and removed. */
  readonly deleteAccessToken: Effect.Effect<boolean, PlatformError>;
}

/**
 * Credentials - Service tag for access token persistence.
 */
export class Credentials extends Context.Service<Credentials, CredentialsShape>()(
  "supabase/auth/Credentials",
) {}
