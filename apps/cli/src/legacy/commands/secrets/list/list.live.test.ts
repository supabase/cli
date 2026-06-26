import { expect, test } from "vitest";

import {
  describeLive,
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Project-scoped read-only scenario. Skipped unless SUPABASE_LIVE_PROJECT_REF is
// set — i.e. a project has been provisioned on the stack (the cli-e2e-ci runner
// does this; a control-plane-only stack, like local macOS, skips it).
//
// Secrets are edge-function env vars served by the Management API control plane
// (no project DB needed), so this is safe to run against a freshly provisioned
// project regardless of data-plane health — a new project simply has an empty
// secrets list, which is still a valid `{ secrets: [] }` payload.
describeLiveProject("supabase secrets list (live)", () => {
  test("lists secrets for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "secrets",
      "list",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test("emits secrets as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout } = await runSupabaseLive([
      "secrets",
      "list",
      "--project-ref",
      ref,
      "--output-format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Payload-only JSON shaped like { secrets: [{ name, value }], message }.
    // Assert the envelope shape rather than specific rows — a fresh project may
    // legitimately have zero secrets, but the array must always be present.
    const parsed = JSON.parse(stdout) as { secrets: Array<{ name: string; value: string }> };
    expect(Array.isArray(parsed.secrets)).toBe(true);
  });
});

// Project-scoped error path that needs NO provisioned project: a valid token
// with an unknown `--project-ref` must reach the live Management API, come back
// 404, and surface as a non-zero exit (not a crash, not "Unauthorized"). Runs
// under `describeLive` so it exercises the request path + error mapping even on
// a control-plane-only stack.
describeLive("supabase secrets list — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "secrets",
      "list",
      "--project-ref",
      "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
    ]);
    const out = `${stdout}${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(out).not.toContain("Unauthorized");
    expect(out).toContain("404");
  });
});
