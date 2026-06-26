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
// Backups are listed via the Management API control plane (no project DB query),
// so this runs against a freshly provisioned project regardless of data-plane
// health — a new project simply has an empty backups list.
describeLiveProject("supabase backups list (live)", () => {
  test("lists backups for the project", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "backups",
      "list",
      "--project-ref",
      ref,
    ]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test("emits backups as machine-readable JSON", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const ref = requireLiveProjectRef();
    const { exitCode, stdout } = await runSupabaseLive([
      "backups",
      "list",
      "--project-ref",
      ref,
      "--output-format",
      "json",
    ]);
    expect(exitCode).toBe(0);
    // Payload-only JSON shaped like { backups: [...], ... }. A fresh project may
    // have zero backups, but the array must always be present.
    const parsed = JSON.parse(stdout) as { backups: unknown[] };
    expect(Array.isArray(parsed.backups)).toBe(true);
  });
});

// Project-scoped error path needing NO provisioned project: a valid token with
// an unknown --project-ref must reach the live Management API, come back 404,
// and exit non-zero (not a crash, not "Unauthorized").
describeLive("supabase backups list — unknown project (live)", () => {
  test("fails with a 404 for an unknown project ref", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive([
      "backups",
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
