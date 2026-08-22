import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  makeTempLegacyStackProject,
  requireCliSuccess,
  runSupabase,
} from "../../../../tests/helpers/cli.ts";
import { legacySanitizeProjectId } from "../../shared/legacy-docker-ids.ts";

const execFileAsync = promisify(execFile);

const CLI_COMMAND_TIMEOUT_MS = 60_000;
const STACK_START_TIMEOUT_MS = 280_000;
const STOP_COMMAND_TIMEOUT_MS = 120_000;
const DOCKER_INSPECT_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const LIFECYCLE_MARGIN_MS = 30_000;
const CLEANUP_HOOK_TIMEOUT_MS = CLEANUP_TIMEOUT_MS + LIFECYCLE_MARGIN_MS;
const STOP_TEST_TIMEOUT_MS =
  CLI_COMMAND_TIMEOUT_MS +
  STACK_START_TIMEOUT_MS +
  CLI_COMMAND_TIMEOUT_MS +
  STOP_COMMAND_TIMEOUT_MS +
  DOCKER_INSPECT_TIMEOUT_MS +
  LIFECYCLE_MARGIN_MS;

// `stop` never calls the Management API — it talks directly to the real local
// Docker stack `start` creates. `describe` gates
// purely as the "we're in the full cli-e2e-ci runner" signal (it also has a
// real Docker daemon, since that's how supabox itself runs); the
// SUPABASE_ACCESS_TOKEN it gates on is otherwise irrelevant here. See
// AGENTS.md's "e2e tests" section for the full convention.
describe("supabase stop (e2e)", () => {
  let project: Awaited<ReturnType<typeof makeTempLegacyStackProject>> | undefined;
  let projectId: string | undefined;

  afterEach(async () => {
    await project?.cleanup().catch(() => undefined);
    project = undefined;
    projectId = undefined;
  }, CLEANUP_HOOK_TIMEOUT_MS);

  test(
    "starts a real local stack, then stops it and removes its containers",
    { timeout: STOP_TEST_TIMEOUT_MS },
    async () => {
      project = await makeTempLegacyStackProject("sb-stop-e2e-");
      const projectDir = project.dir;
      // No `project_id` override, so the cli resolves it from the workdir
      // basename (see legacy-docker-ids.ts).
      projectId = path.basename(projectDir);

      const init = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      // Exclude the heaviest, least relevant services (Next.js Studio build, the
      // logging pipeline) — `stop`'s Docker label-filtering logic doesn't care
      // which services are running, only that at least one real container
      // exists to stop.
      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // Sanity: confirm the stack is actually up before testing `stop` against it.
      const before = await runSupabase(["status"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(before, "status setup");

      const stop = await runSupabase(["stop"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
      });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain("Stopped");

      // The real Docker daemon must agree: no container carrying this project's
      // label survives `stop` — the actual behavior under test, not just the
      // cli's own exit code.
      const { stdout: remaining } = await execFileAsync(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--format",
          "{{.ID}}",
        ],
        { timeout: DOCKER_INSPECT_TIMEOUT_MS },
      );
      expect(remaining.trim()).toBe("");
    },
  );

  test(
    "stop --no-backup --debug reports real pruned containers, volumes, and network",
    { timeout: STOP_TEST_TIMEOUT_MS },
    async () => {
      project = await makeTempLegacyStackProject("sb-stop-e2e-");
      const projectDir = project.dir;
      // Sanitizing is a no-op for a `mkdtemp`-generated basename (already
      // alphanumeric/`-`), but mirrors the port's actual resolution rather
      // than assuming that stays true (same note as `start.e2e.test.ts`).
      projectId = legacySanitizeProjectId(path.basename(projectDir));

      const init = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");

      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { entrypoint: "legacy", cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // `--no-backup` exercises the volume-prune branch; `--debug` turns on
      // the `Pruned …:` stderr reports, which are
      // backed by parsing REAL `docker`/`podman` prune stdout — the format
      // assumption (`Deleted …:` headers, `Total reclaimed space:` trailer)
      // that mocked integration fixtures cannot validate by construction.
      const stop = await runSupabase(["stop", "--no-backup", "--debug"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
      });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain("Stopped");

      // Containers: real Docker reports full hex IDs — the list must be
      // non-empty, since the started stack's containers were just removed.
      expect(stop.stderr).toMatch(/^Pruned containers: \[[0-9a-f][^\]]*\]$/mu);
      // Volumes: the db volume always exists (db is never excluded), so the
      // report must name it. Other project volumes may also appear.
      const volumesLine = stop.stderr
        .split("\n")
        .find((line) => line.startsWith("Pruned volumes: ["));
      expect(volumesLine, `stderr:\n${stop.stderr}`).toContain(`supabase_db_${projectId}`);
      // Network: exactly the project network; the established label is singular
      // "network", unlike the other two reports.
      expect(stop.stderr).toContain(`Pruned network: [supabase_network_${projectId}]`);

      // The real Docker daemon must agree with the report: nothing carrying
      // this project's label survives.
      const { stdout: remaining } = await execFileAsync(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.supabase.cli.project=${projectId}`,
          "--format",
          "{{.ID}}",
        ],
        { timeout: DOCKER_INSPECT_TIMEOUT_MS },
      );
      expect(remaining.trim()).toBe("");
    },
  );
});
