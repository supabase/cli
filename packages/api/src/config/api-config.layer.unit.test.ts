import { describe, expect, test } from "vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";

import { apiConfigLayer, DEFAULT_SUPABASE_API_URL } from "./api-config.layer.ts";
import { ApiConfig } from "./api-config.service.ts";

describe("apiConfigLayer", () => {
  test("defaults the API URL and reads the access token from config", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ApiConfig.pipe(
          Effect.provide(
            apiConfigLayer.pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    SUPABASE_ACCESS_TOKEN: "env-token",
                  }),
                ),
              ),
            ),
          ),
        );

        expect(config.baseUrl).toBe(DEFAULT_SUPABASE_API_URL);
        expect(Option.isSome(config.accessToken)).toBe(true);
      }),
    ));
});
