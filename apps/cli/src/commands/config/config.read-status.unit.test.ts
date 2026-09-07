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

  test("every other status keeps the generic unexpected-status shape", () => {
    expect(legacyConfigReadStatusMessage(500, '{"message":"boom"}', REF, API_HOST)).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});
