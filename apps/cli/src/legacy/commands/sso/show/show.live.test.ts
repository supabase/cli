import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `sso show` requires an existing provider ID, which a freshly provisioned
// project does not have — so there is no stable success path to assert here
// (provider lifecycle is out of scope for read-only live coverage).
//
// The portable live signal is the request path + error mapping: a valid token
// with an unknown --project-ref (and any provider ID) must reach the live
// Management API, come back 404, and exit non-zero. Runs under `describeLive`
// so it needs no provisioned project.
describeLive("supabase sso show — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "sso",
      "show",
      "00000000-0000-0000-0000-000000000000", // well-formed UUID, nonexistent provider
      "--project-ref",
      "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
