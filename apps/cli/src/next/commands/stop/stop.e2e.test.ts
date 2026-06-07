import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, makeTempStackProject, runSupabase } from "../../../../tests/helpers/cli.ts";

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
const STOP_STACK_TIMEOUT_MS = 30_000;

describe("supabase stop", () => {
  test(
    "preserves the persisted stack folder by default",
    { timeout: STOP_STACK_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-stop-e2e-");
      const stackDir = join(project.dir, ".supabase", "stacks", "default");

      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
      });
      expect(startResult.exitCode).toBe(0);

      const stopResult = await runSupabase(["stop"], { cwd: project.dir, home: home.dir });
      expect(stopResult.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(true);
      expect(existsSync(join(stackDir, "stack.json"))).toBe(true);
      expect(existsSync(join(stackDir, "state.json"))).toBe(false);
    },
  );

  test(
    "deletes the persisted stack folder with --no-backup",
    { timeout: STOP_STACK_TIMEOUT_MS },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-stop-e2e-");
      const stackDir = join(project.dir, ".supabase", "stacks", "default");

      const startResult = await runSupabase([...LIGHTWEIGHT_START_ARGS], {
        cwd: project.dir,
        home: home.dir,
      });
      expect(startResult.exitCode).toBe(0);

      const stopResult = await runSupabase(["stop", "--no-backup"], {
        cwd: project.dir,
        home: home.dir,
      });
      expect(stopResult.exitCode).toBe(0);
      expect(existsSync(stackDir)).toBe(false);
    },
  );
});
