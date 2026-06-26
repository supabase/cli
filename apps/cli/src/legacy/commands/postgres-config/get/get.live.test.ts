import { expect, test } from "vitest";

import {
  describeLive,
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Project-scoped read-only scenario. Skipped unless SUPABASE_LIVE_PROJECT_REF is
// set (the cli-e2e-ci runner provisions a project; a control-plane-only stack
// skips it). Reads the project's Postgres config via the Management API control
// plane — every project exposes a config object regardless of data-plane health.
describeLiveProject("supabase postgres-config get (live)", () => {
  test("gets the Postgres config for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "postgres-config",
      "get",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test(
    "emits the Postgres config as machine-readable JSON",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout } = await runSupabaseLive([
        "postgres-config",
        "get",
        "--project-ref",
        ref,
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // Payload-only JSON: the Postgres config is a single object, not an array.
      const parsed: unknown = JSON.parse(stdout);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    },
  );
});

// Error path needing NO provisioned project: unknown --project-ref → 404.
describeLive("supabase postgres-config get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "postgres-config",
      "get",
      "--project-ref",
      "a".repeat(20),
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
