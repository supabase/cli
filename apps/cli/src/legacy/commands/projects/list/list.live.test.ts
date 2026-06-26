import { expect, test } from "vitest";

import {
  describeLive,
  liveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 60_000;

// Account-level read-only live scenario, alongside `orgs list`. Lists every
// project the authenticated token can access — no project ref required, so it
// runs against just the control plane (no provisioned project instance needed).
// Safe to run repeatedly; creates nothing.
describeLive("supabase projects list (live)", () => {
  test("lists projects for the authenticated token", { timeout: LIVE_TIMEOUT_MS }, async () => {
    const { exitCode, stdout, stderr } = await runSupabaseLive(["projects", "list"]);
    expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
    expect(exitCode).toBe(0);
  });

  test(
    "emits projects as machine-readable JSON, including the provisioned project",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout } = await runSupabaseLive([
        "projects",
        "list",
        "--output-format",
        "json",
      ]);
      expect(exitCode).toBe(0);
      // Payload-only JSON shaped like { projects: [{ id, ref, name, status, … }], message }.
      const parsed = JSON.parse(stdout) as {
        projects: Array<{ id: string; ref: string; name: string }>;
      };
      expect(Array.isArray(parsed.projects)).toBe(true);
      const ref = liveProjectRef();
      if (ref) {
        // When the runner provisioned a project, it must appear in the listing —
        // proves the JSON reflects real platform state, not just valid syntax.
        expect(parsed.projects.map((project) => project.ref)).toContain(ref);
      }
    },
  );
});
