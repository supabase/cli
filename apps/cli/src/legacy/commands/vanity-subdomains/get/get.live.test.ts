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
// skips it). Reads the project's vanity subdomain config via the Management API
// control plane — a fresh project returns a status object (e.g. not used).
describeLiveProject("supabase vanity-subdomains get (live)", () => {
  test(
    "gets the vanity subdomain config for the project",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout, stderr } = await runSupabaseLive([
        "vanity-subdomains",
        "get",
        "--project-ref",
        ref,
      ]);
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode).toBe(0);
    },
  );

  test(
    "emits the vanity subdomain config as machine-readable JSON",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout } = await runSupabaseLive([
        "vanity-subdomains",
        "get",
        "--project-ref",
        ref,
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // Payload-only JSON: a status object like { status, custom_domain? }.
      const parsed = JSON.parse(stdout) as { status?: string };
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      expect(typeof parsed.status).toBe("string");
    },
  );
});

// Error path needing NO provisioned project: unknown --project-ref → 404.
describeLive("supabase vanity-subdomains get — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "vanity-subdomains",
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
