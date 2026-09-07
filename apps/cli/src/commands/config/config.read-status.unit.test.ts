import { describe, expect, test } from "vitest";

import {
  legacyConfigReadStatusMessage,
  legacyUnexpectedStatusMessage,
} from "./config.read-status.ts";

const REF = "abcdefghijklmnopqrst";

describe("legacyUnexpectedStatusMessage", () => {
  test("shapes the generic unexpected-status message", () => {
    expect(legacyUnexpectedStatusMessage(500, '{"message":"boom"}')).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});

describe("legacyConfigReadStatusMessage", () => {
  test("401 points at re-authenticating", () => {
    expect(legacyConfigReadStatusMessage(401, '{"message":"unauthorized"}', REF)).toBe(
      "Authentication failed: your access token is invalid or has expired. Run `supabase login` to re-authenticate.",
    );
  });

  test("403 names the sanitized ref and denies access", () => {
    expect(legacyConfigReadStatusMessage(403, '{"message":"forbidden"}', REF)).toBe(
      `Access denied for project ${REF}: your account does not have permission to view its configuration.`,
    );
  });

  test("404 names the sanitized ref and suggests projects list", () => {
    expect(legacyConfigReadStatusMessage(404, '{"message":"not found"}', REF)).toBe(
      `Project ${REF} not found. Check the project ref, or run \`supabase projects list\` to see the projects you have access to.`,
    );
  });

  test("every other status keeps the generic unexpected-status shape", () => {
    expect(legacyConfigReadStatusMessage(500, '{"message":"boom"}', REF)).toBe(
      'unexpected status 500: {"message":"boom"}',
    );
  });
});
