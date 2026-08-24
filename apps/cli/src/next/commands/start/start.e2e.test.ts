import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeTempCliProject, makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";
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
// container lifecycle boundaries, so keep one golden-path Docker e2e test.
describe("supabase start lazy lifecycle (e2e)", () => {
  let project: Awaited<ReturnType<typeof makeTempCliProject>> | undefined;
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
      project = await makeTempCliProject("supabase-lazy-start-e2e-");
      home = makeTempHome();
      await mkdir(join(project.dir, "supabase"), { recursive: true });
      const projectId = basename(project.dir)
        .replace(/[^a-z0-9]/giu, "")
        .toLowerCase();
      await writeFile(
        join(project.dir, "supabase", "config.toml"),
        `project_id = "${projectId}"\n`,
      );

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

      const apiUrlMatch =
        `${started.stdout}\n${started.stderr}\n${before.stdout}\n${before.stderr}`.match(
          /API URL:\s+(https?:\/\/[^\s]+)/,
        );
      if (apiUrlMatch?.[1] === undefined) {
        throw new Error(
          `Start/status output did not include an API URL.\nstdout:\n${before.stdout}\nstderr:\n${before.stderr}`,
        );
      }

      const response = await fetch(`${apiUrlMatch[1]}/auth/v1/health`, {
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
