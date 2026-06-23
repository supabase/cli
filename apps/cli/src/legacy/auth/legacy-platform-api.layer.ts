import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { CLI_VERSION } from "../../shared/cli/version.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyDebugLogger } from "../shared/legacy-debug-logger.service.ts";
import { LegacyIdentityStitch } from "../shared/legacy-identity-stitch.ts";
import { validateLegacyAccessToken } from "./legacy-access-token.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyPlatformAuthRequiredError } from "./legacy-errors.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

export const legacyMakePlatformApi = Effect.gen(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;
  const debugLogger = yield* LegacyDebugLogger;
  // Go wraps every Management API response in identityTransport for session
  // identity stitching. Consume the single per-command stitcher service rather
  // than building one here, so the typed client shares the one `stitchAttempted`
  // guard with the raw advisor GETs and the linked-project cache (Go's single
  // root-context `sync.Once`); otherwise each transport would re-alias/re-persist.
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

  const configuredToken = cliConfig.accessToken;
  const resolveAccessToken = Effect.gen(function* () {
    if (Option.isSome(configuredToken)) {
      yield* debugLogger.debug("Using access token from env var...");
      // Go's GetSupabase() → LoadAccessTokenFS validates the token — including the
      // env value — against the sbp_ pattern before any API call
      // (internal/utils/api.go:121, access_token.go:24-41). credentials.getAccessToken
      // already validates the keyring/file paths; validate the env token here too so
      // a malformed SUPABASE_ACCESS_TOKEN fails with the invalid-token error rather
      // than being sent to the API.
      yield* validateLegacyAccessToken(Redacted.value(configuredToken.value));
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
  yield* debugLogger.debug(`Using profile: ${cliConfig.profile} (${cliConfig.projectHost})`);
  const storedToken = yield* resolveAccessToken;
  if (Option.isNone(storedToken)) {
    return yield* Effect.fail(
      new LegacyPlatformAuthRequiredError({ message: MISSING_TOKEN_MESSAGE }),
    );
  }

  return yield* makeApiClient(
    {
      baseUrl: cliConfig.apiUrl,
      accessToken: storedToken.value,
      userAgent: cliConfig.userAgent,
    },
    {
      transformClient,
    },
  );
});

export const legacyPlatformApiLayer = Layer.effect(LegacyPlatformApi, legacyMakePlatformApi);
