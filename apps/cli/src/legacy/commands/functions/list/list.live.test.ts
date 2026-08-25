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
