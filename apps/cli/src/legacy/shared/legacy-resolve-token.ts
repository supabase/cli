import { Effect, Option, Redacted } from "effect";

import { LegacyCredentials } from "../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";

/**
 * Resolves the Management API access token, preferring an env-set value on
 * `LegacyCliConfig.accessToken` over the keyring / file-backed credentials
 * service.
 *
 * Returns `None` if no token is available. Callers that POST/PUT via the raw
 * `HttpClient.HttpClient` use this to build an `Authorization: Bearer` header
 * — typed-API-client callers don't need this because the API layer reads the
 * token at layer-construction time. Shared between `sso add`, `sso update`,
 * and any future raw-HTTP handlers that need the same fallback order.
 *
 * `Effect.catch` on the credentials lookup absorbs the validation error
 * (`LegacyInvalidAccessTokenError`) into `None`. Handlers that need a token
 * present should treat a `None` result as a hard failure; the typed API
 * client's auth pipeline surfaces token-validation errors itself.
 */
export const resolveLegacyAccessToken: Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  never,
  LegacyCliConfig | LegacyCredentials
> = Effect.gen(function* () {
  const cliConfig = yield* LegacyCliConfig;
  if (Option.isSome(cliConfig.accessToken)) {
    return cliConfig.accessToken;
  }
  const credentials = yield* LegacyCredentials;
  return yield* credentials.getAccessToken.pipe(
    Effect.catch(() => Effect.succeed(Option.none<Redacted.Redacted<string>>())),
  );
});
