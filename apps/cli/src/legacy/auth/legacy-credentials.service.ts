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
}

export class LegacyCredentials extends Context.Service<LegacyCredentials, LegacyCredentialsShape>()(
  "supabase/legacy/Credentials",
) {}
