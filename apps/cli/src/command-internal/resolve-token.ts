import { Effect, Option, Redacted } from "effect";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";

/**
 * Resolves the Management API access token, preferring an env-set value on
 * `CommandSettings.accessToken` over the keyring / file-backed credentials
 * service.
 *
 * Returns `None` if no token is available. Callers that POST/PUT via the raw
 * `HttpClient.HttpClient` use this to build an `Authorization: Bearer` header —
 * typed-API-client callers don't need this because the API layer reads the
 * token at layer-construction time. Shared between `sso add`, `sso update`,
 * and any future raw-HTTP handlers that need the same fallback order.
 *
 * `Effect.catch` on the credentials lookup absorbs the validation error
 * (`InvalidAccessTokenError`) into `None`. Handlers that need a token
 * present should treat a `None` result as a hard failure; the typed API
 * client's auth pipeline surfaces token-validation errors itself.
 */
export const resolveAccessToken: Effect.Effect<
  Option.Option<Redacted.Redacted<string>>,
  never,
  CommandSettings | CommandCredentials
> = Effect.gen(function* () {
  const cliSettings = yield* CommandSettings;
  if (Option.isSome(cliSettings.accessToken)) {
    return cliSettings.accessToken;
  }
  const credentials = yield* CommandCredentials;
  return yield* credentials.getAccessToken.pipe(
    Effect.catch(() => Effect.succeed(Option.none<Redacted.Redacted<string>>())),
  );
});
