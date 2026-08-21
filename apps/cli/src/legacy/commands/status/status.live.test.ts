import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../tests/helpers/live.ts";
import { requireLiveSuccess } from "../../../../tests/helpers/live-context.ts";

const START_TIMEOUT_MS = 280_000;

// See stop.live.test.ts for why `describeLive` (not a Management-API gate) is
// the right reuse here: `status` never calls the Management API, only the real
// Docker daemon the cli-e2e-ci runner provides. See AGENTS.md's "Live tests"
// section for the full convention.
describeLive("supabase status (live)", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    await runSupabaseLive(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
  });

  test(
    "reports a running local stack in pretty and json modes",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-status-live-"));

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      requireLiveSuccess(init, "init setup");

      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireLiveSuccess(start, "start setup");

      const pretty = await runSupabaseLive(["status"], { cwd: projectDir });
      expect(pretty.exitCode, `stdout:\n${pretty.stdout}\nstderr:\n${pretty.stderr}`).toBe(0);
      expect(`${pretty.stdout}${pretty.stderr}`).toContain("is running");
      expect(pretty.stdout).toContain("Project URL");
      expect(pretty.stdout).toContain("Database");

      const json = await runSupabaseLive(["status", "-o", "json"], { cwd: projectDir });
      expect(json.exitCode, `stdout:\n${json.stdout}\nstderr:\n${json.stderr}`).toBe(0);
      const parsed: unknown = JSON.parse(json.stdout);
      expect(parsed).toMatchObject({
        API_URL: expect.stringContaining("http"),
        DB_URL: expect.stringContaining("postgresql://"),
      });
    },
  );
});
