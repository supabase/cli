import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { deriveLiveProjectHost, liveApiUrl, validateLiveConfig } from "./live-env.ts";

const runWithEnv = <A, E>(env: Record<string, string>, effect: Effect.Effect<A, E>): A =>
  Effect.runSync(
    Effect.provideService(
      effect,
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }),
    ),
  );

describe("live environment", () => {
  it("requires both the API URL and access token", () => {
    expect(() => runWithEnv({}, validateLiveConfig)).toThrow("SUPABASE_LIVE_API_URL is required");

    const apiUrlOnly = { SUPABASE_LIVE_API_URL: "http://localhost:8080" };
    expect(() => runWithEnv(apiUrlOnly, validateLiveConfig)).toThrow(
      "SUPABASE_ACCESS_TOKEN is required",
    );
  });

  it("normalizes and validates HTTP API URLs", () => {
    const env = {
      SUPABASE_LIVE_API_URL: "http://localhost:8080///",
      SUPABASE_ACCESS_TOKEN: " token ",
    };
    expect(runWithEnv(env, validateLiveConfig)).toEqual({
      apiUrl: "http://localhost:8080",
      accessToken: "token",
    });
    expect(() => runWithEnv({ ...env, SUPABASE_LIVE_API_URL: "not-a-url" }, liveApiUrl)).toThrow(
      "absolute HTTP(S) URL",
    );
  });

  it("derives the project host from the typed database host", () => {
    expect(
      deriveLiveProjectHost("db.abcdefghijklmnopqrst.supabase.co", "abcdefghijklmnopqrst"),
    ).toBe("supabase.co");
    expect(() => deriveLiveProjectHost("postgres.supabase.co", "abcdefghijklmnopqrst")).toThrow(
      "Cannot derive project host",
    );
  });
});
