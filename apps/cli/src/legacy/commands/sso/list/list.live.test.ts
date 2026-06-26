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
// skips it). Lists the project's SSO identity providers via the Management API
// control plane — a fresh project has none, which is a valid empty list.
describeLiveProject("supabase sso list (live)", () => {
  test("lists SSO providers for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "sso",
      "list",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test("emits SSO providers as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout } = await runSupabaseLive([
      "sso",
      "list",
      "--project-ref",
      ref,
      "--output-format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Payload-only JSON shaped like { providers: [...] }.
    const parsed = JSON.parse(stdout) as { providers: unknown[] };
    expect(Array.isArray(parsed.providers)).toBe(true);
  });
});

// Error path needing NO provisioned project: unknown --project-ref → 404.
describeLive("supabase sso list — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "sso",
      "list",
      "--project-ref",
      "a".repeat(20),
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
