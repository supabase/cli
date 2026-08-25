import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { CLI_VERSION } from "../../shared/cli/version.ts";
import { LegacyCliSettings } from "../config/legacy-cli-settings.service.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import { validateLegacyAccessToken } from "./legacy-access-token.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyPlatformAuthRequiredError } from "./legacy-errors.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

export const legacyMakePlatformApi = Effect.gen(function* () {
  const cliSettings = yield* LegacyCliSettings;
  const credentials = yield* LegacyCredentials;
  const debugLogger = yield* LegacyDebugLogger;
  // Every Management API response is passed through the per-command identity
  // stitcher for session identity stitching. Consume the single per-command
  // stitcher service rather than building one here, so the typed client shares
  // the one `stitchAttempted` guard with the raw advisor GETs and the
  // linked-project cache; otherwise each transport would re-alias/re-persist.
  const { stitch: stitchIdentityFromResponse } = yield* LegacyIdentityStitch;

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
      // credentials.getAccessToken already validates the keyring/file paths;
      // validate the env token here too so a malformed SUPABASE_ACCESS_TOKEN
      // fails with the invalid-token error rather than being sent to the API.
      yield* validateLegacyAccessToken(Redacted.value(configuredToken.value), "env");
      return configuredToken;
    }
    return yield* credentials.getAccessToken;
  });

  const authGateToken = yield* resolveAccessToken;
  if (Option.isNone(authGateToken)) {
    return yield* Effect.fail(
      new LegacyPlatformAuthRequiredError({ message: MISSING_TOKEN_MESSAGE }),
    );
  }
  yield* debugLogger.debug(`Supabase CLI ${CLI_VERSION}`);
  yield* debugLogger.debug(`Using profile: ${cliSettings.profile} (${cliSettings.projectHost})`);
  const storedToken = yield* resolveAccessToken;
  if (Option.isNone(storedToken)) {
    return yield* Effect.fail(
      new LegacyPlatformAuthRequiredError({ message: MISSING_TOKEN_MESSAGE }),
    );
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

export const legacyPlatformApiLayer = Layer.effect(LegacyPlatformApi, legacyMakePlatformApi);
