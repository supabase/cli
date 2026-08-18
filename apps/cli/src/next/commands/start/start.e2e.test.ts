import { describe, expect, test } from "vitest";
import { makeTempHome, makeTempStackProject, runSupabase } from "../../../../tests/helpers/cli.ts";

const DETACHED_START_TIMEOUT_MS = 30_000;
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

describe("supabase start", () => {
  test(
    "starts in detached mode and prints connection info",
    { timeout: DETACHED_START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-start-e2e-");
      const { stdout, stderr, exitCode } = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: DETACHED_START_TIMEOUT_MS,
      });
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      expect(stdout).toContain("Local Supabase started");
      expect(stdout).toContain("API URL:");
      expect(stdout).toContain("DB URL:");
    },
  );

  test(
    "reattaches when detached start is already running",
    { timeout: DETACHED_START_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-start-e2e-");
      const first = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: DETACHED_START_TIMEOUT_MS,
      });
      expect(first.exitCode, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0);

      const second = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: DETACHED_START_TIMEOUT_MS,
      });
      expect(second.exitCode, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("Start local Supabase stack");
      expect(second.stdout).toContain("Local Supabase started");
    },
  );
});
