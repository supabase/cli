import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

import {
  makeTempCliStackProject,
  overrideStackPorts,
  requireCliSuccess,
  runSupabase,
} from "../../../tests/helpers/cli.ts";
import { sanitizeProjectId } from "../../command-internal/docker-ids.ts";

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

// `stop` never calls the Management API — it talks directly to the real local Docker stack
// `start` creates. The suite gates on `SUPABASE_ACCESS_TOKEN` purely as a "real e2e runner"
// signal, which also guarantees a Docker daemon; see AGENTS.md's "e2e tests" section.
describe("supabase stop (e2e)", () => {
  let project: Awaited<ReturnType<typeof makeTempCliStackProject>> | undefined;
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
      project = await makeTempCliStackProject("sb-stop-e2e-");
      const projectDir = project.dir;
      // No `project_id` override, so the cli resolves it from the workdir
      // basename (see docker-ids.ts).
      projectId = path.basename(projectDir);

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");
      await overrideStackPorts(projectDir);

      // Exclude heavy, irrelevant services (Studio's Next.js build, the logging pipeline);
      // `stop`'s label-filtering only needs at least one real container to exist.
      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // Confirm the stack is actually up before testing `stop` against it.
      const before = await runSupabase(["status"], {
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(before, "status setup");

      const stop = await runSupabase(["stop"], {
        cwd: projectDir,
        exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
      });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain("Stopped");

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
      project = await makeTempCliStackProject("sb-stop-e2e-");
      const projectDir = project.dir;
      // Sanitizing is currently a no-op for a `mkdtemp` basename (already alphanumeric/`-`), but
      // this mirrors the CLI's actual project-id resolution instead of assuming that stays true.
      projectId = sanitizeProjectId(path.basename(projectDir));

      const init = await runSupabase(["init"], {
        cwd: projectDir,
        exitTimeoutMs: CLI_COMMAND_TIMEOUT_MS,
      });
      requireCliSuccess(init, "init setup");
      await overrideStackPorts(projectDir);

      const start = await runSupabase(
        ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: STACK_START_TIMEOUT_MS },
      );
      requireCliSuccess(start, "start setup");

      // `--no-backup` exercises the volume-prune branch; `--debug` turns on the `Pruned …:`
      // stderr reports, which parse real `docker`/`podman` prune stdout — the format assumption
      // (`Deleted …:` headers, `Total reclaimed space:` trailer) that mocked fixtures can't validate.
      const stop = await runSupabase(["stop", "--no-backup", "--debug"], {
        cwd: projectDir,
        exitTimeoutMs: STOP_COMMAND_TIMEOUT_MS,
      });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain("Stopped");

      expect(stop.stderr).toMatch(/^Pruned containers: \[[0-9a-f][^\]]*\]$/mu);
      // The db volume always exists (never excluded), so the report must name it.
      const volumesLine = stop.stderr
        .split("\n")
        .find((line) => line.startsWith("Pruned volumes: ["));
      expect(volumesLine, `stderr:\n${stop.stderr}`).toContain(`supabase_db_${projectId}`);
      // The prune report's network label is singular ("network"), unlike containers/volumes.
      expect(stop.stderr).toContain(`Pruned network: [supabase_network_${projectId}]`);

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
