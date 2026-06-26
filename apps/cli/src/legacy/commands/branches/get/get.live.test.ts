import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// `branches get` resolves a branch within a project, so a stable success path
// needs a project that has branching enabled and a known branch — not
// guaranteed on a freshly provisioned project (branch lifecycle coverage is
// tracked separately in CLI-1834).
//
// The portable live signal is the request path + error mapping: a valid token
// with an unknown --project-ref must reach the live Management API, come back
// 404, and exit non-zero. Runs under `describeLive` so it needs no provisioned
// project.
describeLive("supabase branches get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "branches",
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
