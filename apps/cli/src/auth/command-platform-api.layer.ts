import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { CLI_VERSION } from "../shared/cli/version.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { DebugLogger } from "../command-internal/debug-logger.service.ts";
import { IdentityStitch } from "../command-internal/identity-stitch.ts";
import { validateAccessToken } from "./access-token.ts";
import { CommandCredentials } from "./command-credentials.service.ts";
import { AccessTokenRequiredError } from "./errors.ts";
import { CommandPlatformApi } from "./command-platform-api.service.ts";

const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

export const makeCommandPlatformApi = Effect.gen(function* () {
  const cliSettings = yield* CommandSettings;
  const credentials = yield* CommandCredentials;
  const debugLogger = yield* DebugLogger;
  // Every Management API response goes through the per-command identity stitcher. Consuming
  // the shared service, rather than building one here, keeps its `stitchAttempted` guard shared
  // with the raw advisor GETs and the linked-project cache.
  const { stitch: stitchIdentityFromResponse } = yield* IdentityStitch;

  const transformClient = (client: HttpClient.HttpClient) => {
    const debugClient = HttpClient.mapRequestEffect(client, (request) =>
      debugLogger.http(request.method, request.url).pipe(Effect.as(request)),
    );

    return Effect.succeed(
      HttpClient.transform(debugClient, (requestEffect) =>
        requestEffect.pipe(Effect.tap((response) => stitchIdentityFromResponse(response))),
      ),
    );
  };

  const configuredToken = cliSettings.accessToken;
  const resolveAccessToken = Effect.gen(function* () {
    if (Option.isSome(configuredToken)) {
      yield* debugLogger.debug("Using access token from env var...");
      // credentials.getAccessToken already validates the keyring/file paths; validate the env
      // token here too so a malformed SUPABASE_ACCESS_TOKEN fails with the invalid-token error
      // rather than being sent to the API.
      yield* validateAccessToken(Redacted.value(configuredToken.value), "env");
      return configuredToken;
    }
    return yield* credentials.getAccessToken;
  });

  const authGateToken = yield* resolveAccessToken;
  if (Option.isNone(authGateToken)) {
    return yield* Effect.fail(new AccessTokenRequiredError({ message: MISSING_TOKEN_MESSAGE }));
  }
  yield* debugLogger.debug(`Supabase CLI ${CLI_VERSION}`);
  yield* debugLogger.debug(`Using profile: ${cliSettings.profile} (${cliSettings.projectHost})`);
  const storedToken = yield* resolveAccessToken;
  if (Option.isNone(storedToken)) {
    return yield* Effect.fail(new AccessTokenRequiredError({ message: MISSING_TOKEN_MESSAGE }));
  }

  return yield* makeApiClient(
    {
      baseUrl: cliSettings.apiUrl,
      accessToken: storedToken.value,
      userAgent: cliSettings.userAgent,
    },
    {
      transformClient,
    },
  );
});

export const commandPlatformApiLayer = Layer.effect(CommandPlatformApi, makeCommandPlatformApi);
