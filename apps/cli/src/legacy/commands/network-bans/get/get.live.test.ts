import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `network-bans get` retrieves bans via a dedicated Management API endpoint that
// supabox returns a non-200 for on a freshly provisioned project (verified
// against the live stack: the request reaches the API — not Unauthorized — but
// exits non-zero), so there is no stable success path here.
//
// The portable live signal is the unknown-project path: a valid token with an
// unknown --project-ref must reach the live Management API, come back 404 (the
// status mapper includes the code), and exit non-zero. Runs under `describeLive`
// so it needs no provisioned project.
describeLive("supabase network-bans get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "network-bans",
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
