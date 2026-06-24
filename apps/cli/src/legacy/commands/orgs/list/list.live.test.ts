import { expect, test } from "vitest";
import { describeLive, runSupabaseLive } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Harness smoke for the `live` Vitest project: the canonical example of a live
// test. It exercises the full path — built binary → SUPABASE_PROFILE resolution
// → authenticated Management API request against the running platform — with a
// read-only call, so it is safe to run repeatedly and creates no resources.
//
// Gated by `describeLive`: skipped unless SUPABASE_ACCESS_TOKEN is set (the
// cli-e2e-ci runner provides supabox's seeded PAT). Broader lifecycle scenarios
// (projects, functions, branching, db, storage) build on this same harness.
describeLive("supabase orgs list (live)", () => {
  test(
    "lists organizations for the authenticated token",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabaseLive(["orgs", "list"]);
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode).toBe(0);
    },
  );

  test(
    "emits machine-readable JSON with --output-format json",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabaseLive([
        "orgs",
        "list",
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // stdout must be payload-only valid JSON in json mode (no spinner/log noise).
      expect(() => JSON.parse(stdout)).not.toThrow();
    },
  );

  // Negative path: a bad token must round-trip to the real Management API, come
  // back 401, and surface as a non-zero exit with the upstream "Unauthorized"
  // message — i.e. the cli's auth + error mapping work against the live stack,
  // not just the golden path. Overrides only the token (profile stays set).
  test("fails with Unauthorized for an invalid token", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive(["orgs", "list"], {
      env: { SUPABASE_ACCESS_TOKEN: `sbp_${"0".repeat(40)}` },
    });
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("Unauthorized");
  });
});
