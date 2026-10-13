import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { LoginApi } from "../commands/login/login-api.service.ts";
import {
  DEFAULT_API_URL,
  VALID_TOKEN,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { assertDriftAgainst } from "../../tests/helpers/permission-drift.ts";
import { loginApiLayer, loginProfile } from "./login-api.layer.ts";
import { mapped } from "./command-permissions/model.ts";

const declared = { _tag: "Declared", permissions: mapped(loginProfile) } as const;

describe("loginApiLayer", () => {
  it.effect("fetches the account identity from GET /v1/profile after login", () => {
    const api = mockCommandPlatformApi({
      response: { status: 200, body: { gotrue_id: "gotrue-user-123" } },
    });
    const layer = loginApiLayer.pipe(
      Layer.provide(api.httpClientLayer),
      Layer.provide(mockCommandSettings({ workdir: "/unused-workdir" })),
    );
    return Effect.gen(function* () {
      const loginApi = yield* LoginApi;
      const gotrueId = yield* loginApi.fetchGotrueId(DEFAULT_API_URL, VALID_TOKEN);
      expect(gotrueId).toEqual(Option.some("gotrue-user-123"));
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/profile",
      ]);
      assertDriftAgainst(declared, {
        command: "login-profile block",
        activeFlags: {},
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });
});
