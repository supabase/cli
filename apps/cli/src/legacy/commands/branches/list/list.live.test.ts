import { expect, test } from "vitest";

import {
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Project-scoped read-only scenario. Skipped unless SUPABASE_LIVE_PROJECT_REF is
// set — i.e. a project has been provisioned on the stack (the cli-e2e-ci runner
// does this; a control-plane-only stack, like local macOS, skips it).
//
// Entry point for the branching lifecycle tracked in CLI-1834
// (create / switch / delete) — extend here once a provisioned project is
// available on the full stack.
describeLiveProject("supabase branches list (live)", () => {
  test("lists branches for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "branches",
      "list",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });
});
