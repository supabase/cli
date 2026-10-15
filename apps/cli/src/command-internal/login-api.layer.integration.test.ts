import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { LoginApi } from "../commands/login/login-api.service.ts";
import {
  DEFAULT_API_URL,
  VALID_TOKEN,
  mockCommandPlatformApi,
  mockCommandSettings,
} from "../../tests/helpers/command-mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { loginApiLayer, loginProfile } from "./login-api.layer.ts";

const PROFILE = { gotrue_id: "gotrue-user-123", primary_email: "a@b.co", username: "ab" };

function setup(opts: Parameters<typeof mockCommandPlatformApi>[0]) {
  const api = mockCommandPlatformApi(opts);
  const layer = loginApiLayer.pipe(
    Layer.provide(api.httpClientLayer),
    Layer.provide(mockCommandSettings({ workdir: "/unused-workdir" })),
  );
  return { api, layer };
}

describe("loginApiLayer", () => {
  it.effect("fetches the account identity from GET /v1/profile after login", () => {
    const { api, layer } = setup({ response: { status: 200, body: PROFILE } });
    return Effect.gen(function* () {
      const loginApi = yield* LoginApi;
      const gotrueId = yield* loginApi.fetchGotrueId(DEFAULT_API_URL, VALID_TOKEN);
      expect(gotrueId).toEqual(Option.some("gotrue-user-123"));
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "GET https://api.supabase.com/v1/profile",
      ]);
      assertBlockDrift(loginProfile, {
        activeFlags: {},
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends the profile lookup to the given host with the fresh token", () => {
    const { api, layer } = setup({ response: { status: 200, body: PROFILE } });
    return Effect.gen(function* () {
      const loginApi = yield* LoginApi;
      yield* loginApi.fetchGotrueId("https://api.fresh.example", "sbp_fresh_token");
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toBe("https://api.fresh.example/v1/profile");
      expect(api.requests[0]?.headers["authorization"]).toBe("Bearer sbp_fresh_token");
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips the identity stitch when the profile lookup is forbidden", () => {
    const { api, layer } = setup({ response: { status: 403, body: { message: "Forbidden" } } });
    return Effect.gen(function* () {
      const loginApi = yield* LoginApi;
      const gotrueId = yield* loginApi.fetchGotrueId(DEFAULT_API_URL, VALID_TOKEN);
      expect(gotrueId).toEqual(Option.none());
      expect(api.requests).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
