import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Option } from "effect";

import { apiConfigLayer, DEFAULT_SUPABASE_API_URL } from "./api-config.layer.ts";
import { ApiConfig } from "./api-config.service.ts";

describe("apiConfigLayer", () => {
  test("defaults the API URL and reads the access token from config", async () => {
    const config = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* ApiConfig;
      }).pipe(
        Effect.provide(apiConfigLayer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              SUPABASE_ACCESS_TOKEN: "env-token",
            }),
          ),
        ),
      ),
    );

    expect(config.baseUrl).toBe(DEFAULT_SUPABASE_API_URL);
    expect(Option.isSome(config.accessToken)).toBe(true);
  });
});
