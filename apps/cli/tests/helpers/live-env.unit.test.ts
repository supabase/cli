// oxlint-disable effecttsgo/process-env -- this test verifies the process-environment compatibility boundary.
import { afterEach, describe, expect, it } from "vitest";

import { deriveLiveProjectHost, liveApiUrl, validateLiveConfig } from "./live-env.ts";

const originalApiUrl = process.env["SUPABASE_LIVE_API_URL"];
const originalToken = process.env["SUPABASE_ACCESS_TOKEN"];

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env["SUPABASE_LIVE_API_URL"];
  else process.env["SUPABASE_LIVE_API_URL"] = originalApiUrl;
  if (originalToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
  else process.env["SUPABASE_ACCESS_TOKEN"] = originalToken;
});

describe("live environment", () => {
  it("requires both the API URL and access token", () => {
    delete process.env["SUPABASE_LIVE_API_URL"];
    delete process.env["SUPABASE_ACCESS_TOKEN"];
    expect(() => validateLiveConfig()).toThrow("SUPABASE_LIVE_API_URL is required");

    process.env["SUPABASE_LIVE_API_URL"] = "http://localhost:8080";
    expect(() => validateLiveConfig()).toThrow("SUPABASE_ACCESS_TOKEN is required");
  });

  it("normalizes and validates HTTP API URLs", () => {
    process.env["SUPABASE_LIVE_API_URL"] = "http://localhost:8080///";
    process.env["SUPABASE_ACCESS_TOKEN"] = " token ";
    expect(validateLiveConfig()).toEqual({
      apiUrl: "http://localhost:8080",
      accessToken: "token",
    });
    process.env["SUPABASE_LIVE_API_URL"] = "not-a-url";
    expect(() => liveApiUrl()).toThrow("absolute HTTP(S) URL");
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
