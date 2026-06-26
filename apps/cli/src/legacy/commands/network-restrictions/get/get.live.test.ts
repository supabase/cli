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
// skips it). Reads the project's network restrictions config via the Management
// API control plane — every project has a config object.
describeLiveProject("supabase network-restrictions get (live)", () => {
  test("gets network restrictions for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "network-restrictions",
      "get",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test(
    "emits network restrictions as machine-readable JSON",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      const { exitCode, stdout } = await runSupabaseLive([
        "network-restrictions",
        "get",
        "--project-ref",
        ref,
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // Payload-only JSON: the restrictions config is a single object, not an array.
      const parsed: unknown = JSON.parse(stdout);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      expect(Array.isArray(parsed)).toBe(false);
    },
  );
});

// Error path needing NO provisioned project: a valid token with an unknown
// --project-ref must reach the live Management API and exit non-zero. The
// handler formats non-200s as "failed to retrieve network restrictions;
// received: <body>" without the HTTP status code, so we assert behavior rather
// than a literal "404".
describeLive("supabase network-restrictions get — unknown project (live)", () => {
  test("fails cleanly for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "network-restrictions",
      "get",
      "--project-ref",
      "a".repeat(20),
    ]);
    expect(exitCode).not.toBe(0);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
  });
});
