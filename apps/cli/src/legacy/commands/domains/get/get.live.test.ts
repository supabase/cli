import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `domains get` reads the custom-hostname config, which the Management API only
// returns once a custom hostname has been configured — a freshly provisioned
// project legitimately has none, so there is no stable success path to assert.
//
// The valuable live signal is the request path + error mapping: a valid token
// with an unknown --project-ref must reach the live Management API, come back
// 404, and exit non-zero (not a crash, not "Unauthorized"). Runs under
// `describeLive` so it needs no provisioned project.
describeLive("supabase domains get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "domains",
      "get",
      "--project-ref",
      "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
