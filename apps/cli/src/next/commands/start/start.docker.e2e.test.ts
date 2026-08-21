import { afterEach, describe, expect, test } from "vitest";
import { makeTempHome, makeTempStackProject, runSupabase } from "../../../../tests/helpers/cli.ts";
import { cleanupRegisteredStackProjects } from "../../../../tests/helpers/stack-e2e-cleanup.ts";

const START_TIMEOUT_MS = 180_000;
const COMMAND_OPTIONS = { entrypoint: "next" as const };
const LIGHTWEIGHT_DOCKER_ARGS = [
  "start",
  "--detach",
  "--mode",
  "docker",
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

// Lazy service activation crosses the real proxy, daemon, Docker network, and
// container lifecycle boundaries, so keep one gated golden-path live test.
describe("supabase start lazy lifecycle (e2e)", () => {
  let project: Awaited<ReturnType<typeof makeTempStackProject>> | undefined;
  let home: ReturnType<typeof makeTempHome> | undefined;

  afterEach(async () => {
    await cleanupRegisteredStackProjects();
    project = undefined;
    home = undefined;
  });

  test(
    "keeps an HTTP service dormant until its first proxied request",
    { timeout: START_TIMEOUT_MS + 120_000 },
    async () => {
      project = await makeTempStackProject("supabase-lazy-start-live-");
      home = makeTempHome();

      const started = await runSupabase([...LIGHTWEIGHT_DOCKER_ARGS], {
        ...COMMAND_OPTIONS,
        cwd: project.dir,
        home: home.dir,
        exitTimeoutMs: START_TIMEOUT_MS,
      });
      expect(started.exitCode, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(0);

      const before = await runSupabase(["status"], {
        ...COMMAND_OPTIONS,
        cwd: project.dir,
        home: home.dir,
      });
      expect(before.exitCode, `stdout:\n${before.stdout}\nstderr:\n${before.stderr}`).toBe(0);
      expect(before.stdout).toContain("auth: Dormant");

      const response = await fetch(`http://127.0.0.1:${project.ports.apiPort}/auth/v1/health`, {
        signal: AbortSignal.timeout(60_000),
      });
      expect(response.ok).toBe(true);

      const after = await runSupabase(["status"], {
        ...COMMAND_OPTIONS,
        cwd: project.dir,
        home: home.dir,
      });
      expect(after.exitCode, `stdout:\n${after.stdout}\nstderr:\n${after.stderr}`).toBe(0);
      expect(after.stdout).toContain("auth: Healthy");
    },
  );
});
