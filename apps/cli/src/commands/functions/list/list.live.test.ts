import { describe, expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// TODO(CLI-1834): add deploy + invoke coverage over :443 / {ref}.supabase.red once the project's
// gateway is reachable from the host.
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
      expect(exitCode, stderr).toBe(0);
      expect(stdout, stderr).toMatch(/ID\s+\|\s+NAME\s+\|\s+SLUG\s+\|\s+STATUS/);
    },
  );
});
