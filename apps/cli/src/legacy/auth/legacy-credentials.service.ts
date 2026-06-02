import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

import type {
  LegacyCredentialDeleteError,
  LegacyInvalidAccessTokenError,
} from "./legacy-errors.ts";

interface LegacyCredentialsShape {
  readonly getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    LegacyInvalidAccessTokenError
  >;
  readonly saveAccessToken: (token: string) => Effect.Effect<void, LegacyInvalidAccessTokenError>;
  readonly deleteAccessToken: Effect.Effect<boolean>;
  /**
   * Deletes the stored database-password credential for a project from the OS
   * keyring (keyring service `"Supabase CLI"`, account = the **project ref** —
   * distinct from the access-token entry). Used by `supabase unlink`.
   *
   * Returns `true` when an entry was removed, `false` when none existed or the
   * keyring is unavailable (WSL). Fails with `LegacyCredentialDeleteError` only
   * for real keyring errors (e.g. permission denied), mirroring Go's unlink
   * which ignores `ErrNotFound` / `ErrNotSupported` but surfaces everything else.
   */
  readonly deleteProjectCredential: (
    projectRef: string,
  ) => Effect.Effect<boolean, LegacyCredentialDeleteError>;
}

export class LegacyCredentials extends Context.Service<LegacyCredentials, LegacyCredentialsShape>()(
  "supabase/legacy/Credentials",
) {}
