import { makeApiClient } from "@supabase/api/effect";
import { Effect, Layer, Option } from "effect";

import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "./legacy-credentials.service.ts";
import { LegacyPlatformAuthRequiredError } from "./legacy-errors.ts";
import { LegacyPlatformApi } from "./legacy-platform-api.service.ts";

const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

const makeLegacyPlatformApiServices = Effect.gen(function* () {
  const cliConfig = yield* LegacyCliConfig;
  const credentials = yield* LegacyCredentials;

  // Env takes precedence over keyring/file (already inside LegacyCredentials), but
  // LegacyCliConfig.accessToken is the env value alone — read in the same order Go uses.
  const configuredToken = cliConfig.accessToken;
  const storedToken = Option.isSome(configuredToken)
    ? configuredToken
    : yield* credentials.getAccessToken;

  if (Option.isNone(storedToken)) {
    return yield* Effect.fail(
      new LegacyPlatformAuthRequiredError({ message: MISSING_TOKEN_MESSAGE }),
    );
  }

  const api = yield* makeApiClient({
    baseUrl: cliConfig.apiUrl,
    accessToken: storedToken.value,
    userAgent: cliConfig.userAgent,
  });
  return Layer.succeed(LegacyPlatformApi, api);
});

export const legacyPlatformApiLayer = Layer.unwrap(makeLegacyPlatformApiServices);
