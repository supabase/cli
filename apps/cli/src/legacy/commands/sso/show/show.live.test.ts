import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `sso show` requires an existing provider ID, which a freshly provisioned
// project does not have — so there is no stable success path to assert here
// (provider lifecycle is out of scope for read-only live coverage).
//
// The portable live signal is the request path + error mapping: a valid token
// with an unknown --project-ref (and any provider ID) must reach the live
// Management API and exit non-zero. `legacySsoShow` maps the 404 to a
// "could not be found" error that omits the HTTP status code, so we assert
// behavior rather than a literal "404". Runs under `describeLive` (no project
// needed).
describeLive("supabase sso show — unknown project (live)", () => {
  test("fails cleanly for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "sso",
      "show",
      "00000000-0000-0000-0000-000000000000", // well-formed UUID, nonexistent provider
      "--project-ref",
      "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
  });
});
