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
// This is the entry point for the broader edge-functions coverage tracked in
// CLI-1834 (deploy + invoke over :443 / {ref}.supabase.red), which needs the
// project's gateway reachable from the host — author those here as they become
// runnable on the full stack.
describeLiveProject("supabase functions list (live)", () => {
  test("lists edge functions for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "functions",
      "list",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });
});

// Project-scoped error path that needs NO provisioned project: a valid token
// with an unknown `--project-ref` must reach the live Management API, come back
// 404, and surface as a non-zero exit (not a crash, not "Unauthorized"). This
// exercises the `--project-ref` request path + error mapping on a control-plane-
// only stack, so it runs under `describeLive`, not `describeLiveProject`.
describeLive("supabase functions list — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "functions",
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
