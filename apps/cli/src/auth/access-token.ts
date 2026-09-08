import { Effect } from "effect";

import { aqua } from "../command-internal/colors.ts";
import { InvalidAccessTokenError } from "./errors.ts";

export const ACCESS_TOKEN_PATTERN = /^sbp_(oauth_|v0_)?[a-f0-9]{40}$/;

/**
 * Message shown when no access token is available, passing `supabase login`
 * through the Aqua colour gate. Built lazily because the gate inspects the
 * target stream at call time. Shared by `db advisors` and the sso
 * reconciled-credentials gate.
 */
export const missingAccessTokenMessage = (): string =>
  `Access token not provided. Supply an access token by running ${aqua("supabase login")} or setting the SUPABASE_ACCESS_TOKEN environment variable.`;

const INVALID_ACCESS_TOKEN_MESSAGE = "Invalid access token format. Must be like `sbp_0102...1920`.";

/**
 * Validates an access token against the `sbp_` pattern, failing with
 * `InvalidAccessTokenError`. Runs on the token loaded from env /
 * keyring / file, before any Management API call.
 */
export const validateAccessToken = (
  token: string,
  source?: "env" | "stored",
): Effect.Effect<string, InvalidAccessTokenError> =>
  ACCESS_TOKEN_PATTERN.test(token)
    ? Effect.succeed(token)
    : Effect.fail(
        new InvalidAccessTokenError({
          message: INVALID_ACCESS_TOKEN_MESSAGE,
          source,
        }),
      );
