import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

import type {
  LegacyCredentialDeleteError,
  LegacyDeleteTokenError,
  LegacyInvalidAccessTokenError,
  LegacyNotLoggedInError,
} from "./legacy-errors.ts";

interface LegacyCredentialsShape {
  readonly getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    LegacyInvalidAccessTokenError
  >;
  readonly saveAccessToken: (token: string) => Effect.Effect<void, LegacyInvalidAccessTokenError>;
  /**
   * Deletes the access token, reproducing Go's `utils.DeleteAccessToken`
   * (`apps/cli-go/internal/utils/access_token.go:100-119`) exactly:
   *
   *   1. Remove `~/.supabase/access-token` first. A non-`ENOENT` removal error
   *      fails `LegacyDeleteTokenError`; a missing file is ignored.
   *   2. Best-effort delete of the legacy `access-token` keyring account — any
   *      error other than not-found is swallowed and never affects the outcome.
   *   3. Delete the profile keyring account (account = profile name). This
   *      **alone** decides the result:
   *      - keyring unavailable (no module / WSL / `SUPABASE_NO_KEYRING`) or the
   *        entry is absent → `LegacyNotLoggedInError`;
   *      - a real delete error → `LegacyDeleteTokenError`;
   *      - success → `void`.
   *
   * The deliberate Go quirk this preserves: on a no-keyring host the file is
   * still removed, yet the call fails `LegacyNotLoggedInError` because the
   * profile-keyring delete reports not-supported.
   */
  readonly deleteAccessToken: Effect.Effect<void, LegacyNotLoggedInError | LegacyDeleteTokenError>;
  /**
   * Deletes **every** entry in the `"Supabase CLI"` keyring namespace (project
   * database passwords stored by `link`). Best-effort: never fails, and is a
   * no-op when the keyring is unavailable. Mirrors Go's
   * `credentials.StoreProvider.DeleteAll()` (`store.go:67-78`), used by
   * `supabase logout` after the access token is removed.
   */
  readonly deleteAllProjectCredentials: Effect.Effect<void>;
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
