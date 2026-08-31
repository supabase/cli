import { Effect } from "effect";

import { legacyAqua } from "../shared/legacy-colors.ts";
import { LegacyInvalidAccessTokenError } from "./legacy-errors.ts";

export const LEGACY_ACCESS_TOKEN_PATTERN = /^sbp_(oauth_|v0_)?[a-f0-9]{40}$/;

/**
 * Message shown when no access token is available, passing `supabase login`
 * through the Aqua colour gate. Built lazily because the gate inspects the
 * target stream at call time. Shared by `db advisors` and the sso
 * reconciled-credentials gate.
 */
export const legacyMissingAccessTokenMessage = (): string =>
  `Access token not provided. Supply an access token by running ${legacyAqua("supabase login")} or setting the SUPABASE_ACCESS_TOKEN environment variable.`;

const LEGACY_INVALID_ACCESS_TOKEN_MESSAGE =
  "Invalid access token format. Must be like `sbp_0102...1920`.";

/**
 * Validates an access token against the `sbp_` pattern, failing with
 * `LegacyInvalidAccessTokenError`. Runs on the token loaded from env /
 * keyring / file, before any Management API call.
 */
export const validateLegacyAccessToken = (
  token: string,
  source?: "env" | "stored",
): Effect.Effect<string, LegacyInvalidAccessTokenError> =>
  LEGACY_ACCESS_TOKEN_PATTERN.test(token)
    ? Effect.succeed(token)
    : Effect.fail(
        new LegacyInvalidAccessTokenError({
          message: LEGACY_INVALID_ACCESS_TOKEN_MESSAGE,
          source,
        }),
      );
