import { expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Account-level read-only live scenario, alongside `orgs list`. Lists every
// project the authenticated token can access — no project ref required, so it
// runs against just the control plane (no provisioned project instance needed).
// Safe to run repeatedly; creates nothing.
describeLive("supabase projects list (live)", () => {
  test("lists projects for the authenticated token", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive(["projects", "list"]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test(
    "emits machine-readable JSON with --output-format json",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabaseLive([
        "projects",
        "list",
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // stdout must be payload-only valid JSON in json mode (no spinner/log noise).
      expect(() => JSON.parse(stdout)).not.toThrow();
    },
  );
});
