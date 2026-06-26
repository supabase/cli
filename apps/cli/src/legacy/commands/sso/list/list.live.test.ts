import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `sso list` requires SAML 2.0 to be enabled for the project: the Management API
// returns 404 when it is not, which `legacySsoList` maps to a "SAML disabled"
// error rather than an empty `{ providers: [] }` payload. A freshly provisioned
// project has no SAML entitlement, so there is no stable success path here —
// listing exits non-zero on such a stack.
//
// The portable live signal is the request path + error mapping: a valid token
// with an unknown --project-ref must reach the live Management API and exit
// non-zero (not a crash, not "Unauthorized"). The mapped error intentionally
// omits the HTTP status code, so we assert behavior rather than a literal "404".
describeLive("supabase sso list — unknown project (live)", () => {
  test("fails cleanly for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "sso",
      "list",
      "--project-ref",
      "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
  });
});
