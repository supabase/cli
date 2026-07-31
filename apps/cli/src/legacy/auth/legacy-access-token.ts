import { Effect } from "effect";

import { legacyAqua } from "../shared/legacy-colors.ts";
import { LegacyInvalidAccessTokenError } from "./legacy-errors.ts";

/** Go's `utils.AccessTokenPattern` (`apps/cli-go/internal/utils/access_token.go:16`). */
export const LEGACY_ACCESS_TOKEN_PATTERN = /^sbp_(oauth_)?[a-f0-9]{40}$/;

/**
 * Go's `utils.ErrMissingToken` message (`internal/utils/access_token.go:18`),
 * with `supabase login` through the Aqua colour gate exactly like Go's
 * `Aqua(...)`. Built lazily because the gate inspects the target stream at
 * call time. Shared by `db advisors` and the sso reconciled-credentials gate.
 */
export const legacyMissingAccessTokenMessage = (): string =>
  `Access token not provided. Supply an access token by running ${legacyAqua("supabase login")} or setting the SUPABASE_ACCESS_TOKEN environment variable.`;

/** Go's `utils.ErrInvalidToken` message (`internal/utils/access_token.go:17`). */
const LEGACY_INVALID_ACCESS_TOKEN_MESSAGE =
  "Invalid access token format. Must be like `sbp_0102...1920`.";

/**
 * Validates an access token against the `sbp_` pattern, failing with
 * `LegacyInvalidAccessTokenError`. Mirrors Go's `LoadAccessTokenFS`, which runs
 * the loaded token (env / keyring / file) through `AccessTokenPattern` before
 * any Management API call (`internal/utils/access_token.go:24-33`).
 */
export const validateLegacyAccessToken = (
  token: string,
): Effect.Effect<string, LegacyInvalidAccessTokenError> =>
  LEGACY_ACCESS_TOKEN_PATTERN.test(token)
    ? Effect.succeed(token)
    : Effect.fail(
        new LegacyInvalidAccessTokenError({ message: LEGACY_INVALID_ACCESS_TOKEN_MESSAGE }),
      );
