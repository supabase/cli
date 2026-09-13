import { Effect, Option, Redacted } from "effect";

import { CommandCredentials } from "../auth/command-credentials.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";

/**
 * Resolves the Management API access token: `CommandSettings.accessToken` (env-set) wins
 * over the keyring/file-backed credentials service, and a validation failure
 * (`InvalidAccessTokenError`) resolves to `None` rather than failing.
 *
 * For raw-HTTP callers building their own `Authorization: Bearer` header; typed-API-client
 * callers don't need this since the API layer reads the token at layer-construction time.
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
