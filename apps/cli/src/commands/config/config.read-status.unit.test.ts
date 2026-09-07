import { describe, expect, test } from "vitest";

import {
  legacyConfigReadStatusMessage,
  legacyUnexpectedStatusMessage,
} from "./config.read-status.ts";

const REF = "abcdefghijklmnopqrst";
const API_HOST = "https://api.supabase.com";

describe("legacyUnexpectedStatusMessage", () => {
  test("shapes the generic unexpected-status message", () => {
    expect(legacyUnexpectedStatusMessage(500, '{"message":"boom"}')).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});

describe("legacyConfigReadStatusMessage", () => {
  test("401 points at re-authenticating", () => {
    expect(legacyConfigReadStatusMessage(401, '{"message":"unauthorized"}', REF, API_HOST)).toBe(
      "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.",
    );
  });

  test("403 names the sanitized ref and denies access", () => {
    expect(legacyConfigReadStatusMessage(403, '{"message":"forbidden"}', REF, API_HOST)).toBe(
      `Access denied for project ${REF}: your account does not have permission to view its configuration.`,
    );
  });

  test("404 names the sanitized ref, suggests projects list, and hedges the api host", () => {
    expect(legacyConfigReadStatusMessage(404, '{"message":"not found"}', REF, API_HOST)).toBe(
      `Could not read configuration for project ${REF} (404). Check the project ref with \`supabase projects list\`; if the ref is correct, this Supabase API endpoint may not be available at ${API_HOST}.`,
    );
  });

  test("404 strips control characters from a hostile api host before embedding it inline", () => {
    // `apiHost` traces back to a `SUPABASE_PROFILE` YAML file's `api_url:`
    // value — validated as a well-formed `http(s)://` URL, but not stripped
    // of embedded control characters (`legacy-profile-load.ts` keeps the raw
    // matched string). A crafted profile must not be able to inject terminal
    // control sequences via this message, same as `ref` already can't.
    const hostileHost = "https://api.supabase.com\x1b[31mFAKE\x1b[0m";
    const message = legacyConfigReadStatusMessage(404, '{"message":"not found"}', REF, hostileHost);
    expect(message).not.toContain("\x1b");
    expect(message).toContain("https://api.supabase.com[31mFAKE[0m");
  });

  test("every other status keeps the generic unexpected-status shape", () => {
    expect(legacyConfigReadStatusMessage(500, '{"message":"boom"}', REF, API_HOST)).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});
