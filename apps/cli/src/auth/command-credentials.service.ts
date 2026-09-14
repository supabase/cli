import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

import type {
  CredentialDeleteError,
  DeleteTokenError,
  InvalidAccessTokenError,
  NotLoggedInError,
} from "./errors.ts";

interface CommandCredentialsShape {
  readonly getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    InvalidAccessTokenError
  >;
  readonly saveAccessToken: (token: string) => Effect.Effect<void, InvalidAccessTokenError>;
  /**
   * Deletes the access token: removes the fallback file, best-effort deletes the legacy keyring
   * account, then deletes the profile keyring account, which alone decides the result. The file
   * is removed even on a no-keyring host, where the call still fails `NotLoggedInError`.
   */
  readonly deleteAccessToken: Effect.Effect<void, NotLoggedInError | DeleteTokenError>;
  /**
   * Deletes every entry in the `"Supabase CLI"` keyring namespace (project database passwords
   * stored by `link`). Best-effort: never fails, and no-ops when the keyring is unavailable.
   */
  readonly deleteAllProjectCredentials: Effect.Effect<void>;
  /**
   * Deletes the stored database-password credential for a project from the OS keyring (account =
   * the project ref). Returns `false` when none existed or the keyring is unavailable; fails
   * with `CredentialDeleteError` only for a real keyring error.
   */
  readonly deleteProjectCredential: (
    projectRef: string,
  ) => Effect.Effect<boolean, CredentialDeleteError>;
}

export class CommandCredentials extends Context.Service<
  CommandCredentials,
  CommandCredentialsShape
>()("supabase/cli/CommandCredentials") {}
