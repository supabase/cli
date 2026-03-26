import { describe, expect, test } from "vitest";
import { makeTempHome, makeTempStackProject, runSupabase } from "../../../tests/helpers/cli.ts";

const STATUS_TIMEOUT_MS = 15_000;
const LIGHTWEIGHT_START_ARGS = [
  "start",
  "--detach",
  "--exclude",
  "realtime",
  "--exclude",
  "storage",
  "--exclude",
  "imgproxy",
  "--exclude",
  "mailpit",
  "--exclude",
  "pgmeta",
  "--exclude",
  "studio",
  "--exclude",
  "analytics",
  "--exclude",
  "vector",
  "--exclude",
  "pooler",
] as const;

describe("supabase status", () => {
  test(
    "shows connection info and service states for the current project",
    { timeout: STATUS_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-status-e2e-");
      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: STATUS_TIMEOUT_MS,
      });
      expect(startResult.exitCode).toBe(0);

      const result = await runSupabase(["status"], { cwd: project.dir, home: home.dir });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Show local Supabase stack status");
      expect(result.stdout).toContain("Local Supabase stack is running.");
      expect(result.stdout).toContain("API URL:");
      expect(result.stdout).toContain("DB URL:");
      expect(result.stdout).toContain("Publishable key:");
      expect(result.stdout).toContain("Secret key:");
      expect(result.stdout).toContain("auth:");
      expect(result.stdout).toContain("postgres:");
      expect(result.stdout).not.toContain("Stack status");
      expect(result.stdout).not.toContain("(running) -");
    },
  );
});
