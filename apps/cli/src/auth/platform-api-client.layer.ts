import { Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { supabaseApiClientLayer } from "@supabase/api/effect";

import { CliConfig } from "../config/cli-config.service.ts";
import { PlatformAuthRequiredError } from "./errors.ts";
import { Credentials } from "./credentials.service.ts";

const makePlatformApiClientLayer = Effect.gen(function* () {
  const cliConfig = yield* CliConfig;
  const credentials = yield* Credentials;

  const configuredToken = cliConfig.accessToken;
  const storedToken = yield* credentials.getAccessToken;
  const token = Option.isSome(configuredToken) ? configuredToken : storedToken;

  if (Option.isNone(token)) {
    return yield* Effect.fail(
      new PlatformAuthRequiredError({
        message: "You are not logged in to Supabase.",
        detail: "Platform commands require a management API access token.",
        suggestion: "Run `supabase login` or set SUPABASE_ACCESS_TOKEN before retrying.",
      }),
    );
  }

  return supabaseApiClientLayer({
    baseUrl: cliConfig.apiUrl,
    accessToken: token.value,
    userAgent: "@supabase/cli",
  }).pipe(Layer.provide(FetchHttpClient.layer));
});

export const platformApiClientLayer = Layer.unwrap(makePlatformApiClientLayer);
