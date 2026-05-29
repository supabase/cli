import type { Effect, Option, Redacted } from "effect";
import { Context } from "effect";

import type { LegacyInvalidAccessTokenError } from "./legacy-errors.ts";

interface LegacyCredentialsShape {
  readonly getAccessToken: Effect.Effect<
    Option.Option<Redacted.Redacted<string>>,
    LegacyInvalidAccessTokenError
  >;
  readonly saveAccessToken: (token: string) => Effect.Effect<void, LegacyInvalidAccessTokenError>;
  readonly deleteAccessToken: Effect.Effect<boolean>;
  /**
   * Best-effort delete of a per-project-ref keyring credential. Mirrors Go's
   * `credentials.StoreProvider.Delete(ref)` (`store.go:54-65`) as used by
   * `projects delete`. Returns `Some(message)` with the stderr line the caller
   * should surface (Go prints it via `fmt.Fprintln(os.Stderr, err)`) for
   * non-recoverable failures such as an unsupported keyring; returns `None` when
   * the delete succeeds or the entry does not exist (Go swallows
   * `keyring.ErrNotFound`).
   */
  readonly deleteProjectCredential: (ref: string) => Effect.Effect<Option.Option<string>>;
}

export class LegacyCredentials extends Context.Service<LegacyCredentials, LegacyCredentialsShape>()(
  "supabase/legacy/Credentials",
) {}
