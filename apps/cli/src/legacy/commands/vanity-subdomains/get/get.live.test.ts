import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `vanity-subdomains get` is plan-gated: the Management API contract returns 400
// when the org is not on a Pro/Team/Enterprise plan, so a freshly provisioned
// project under a non-entitled org has no stable success path here.
//
// The portable live signal is the unknown-project path: a valid token with an
// unknown --project-ref must reach the live Management API, come back 404 (the
// status mapper includes the code), and exit non-zero. Runs under `describeLive`
// so it needs no provisioned project.
describeLive("supabase vanity-subdomains get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "vanity-subdomains",
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
