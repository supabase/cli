import { Config, Effect, Layer } from "effect";

import { ApiConfig } from "./api-config.service.ts";

export const DEFAULT_SUPABASE_API_URL = "https://api.supabase.com";

const makeApiConfig = Effect.gen(function* () {
  return ApiConfig.of({
    baseUrl: yield* Config.string("SUPABASE_API_URL").pipe(
      Config.withDefault(DEFAULT_SUPABASE_API_URL),
    ),
    accessToken: yield* Config.option(Config.redacted("SUPABASE_ACCESS_TOKEN")),
  });
});

export const apiConfigLayer = Layer.effect(ApiConfig, makeApiConfig);
