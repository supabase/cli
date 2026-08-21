import { describe, expect } from "vitest";

import { test } from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// This is the entry point for the broader edge-functions coverage tracked in
// CLI-1834 (deploy + invoke over :443 / {ref}.supabase.red), which needs the
// project's gateway reachable from the host — author those here as they become
// runnable on the full stack.
describe("supabase functions list (live)", () => {
  test(
    "lists edge functions for the project",
    { timeout: LIVE_TIMEOUT_MS },
    async ({ cli, project }) => {
      const { exitCode, stdout, stderr } = await cli([
        "functions",
        "list",
        "--project-ref",
        project.ref,
      ]);
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(exitCode).toBe(0);
    },
  );
});

// Project-scoped error path that needs NO provisioned project: a valid token
// with an unknown `--project-ref` must reach the live Management API, come back
// 404, and surface as a non-zero exit (not a crash, not "Unauthorized"). This
// exercises the `--project-ref` request path + error mapping on a control-plane-
// only stack, so it runs under the same shared live fixture.
describe("supabase functions list — unknown project (live)", () => {
  test(
    "fails with a 404 for an unknown project ref",
    { timeout: LIVE_TIMEOUT_MS },
    async ({ cli }) => {
      const { exitCode, stdout, stderr } = await cli([
        "functions",
        "list",
        "--project-ref",
        "a".repeat(20), // well-formed (20 lowercase chars) but nonexistent ref
      ]);
      const out = `${stdout}${stderr}`;
      expect(exitCode).not.toBe(0);
      expect(out).not.toContain("Unauthorized");
      expect(out).toContain("404");
    },
  );
});
