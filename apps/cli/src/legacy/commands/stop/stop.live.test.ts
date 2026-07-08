import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { describeLive, runSupabaseLive } from "../../../../tests/helpers/live.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;

// `stop` never calls the Management API — it talks directly to the real local
// Docker stack `start` (still a Go-proxy) creates. `describeLive` is reused
// purely as the "we're in the full cli-e2e-ci runner" signal (it also has a
// real Docker daemon, since that's how supabox itself runs); the
// SUPABASE_ACCESS_TOKEN it gates on is otherwise irrelevant here. See
// AGENTS.md's "Live tests" section for the full convention.
describeLive("supabase stop (live)", () => {
  let projectDir: string | undefined;
  let projectId: string | undefined;

  afterEach(async () => {
    if (projectDir === undefined) return;
    // Best-effort cleanup even if an assertion above failed mid-lifecycle — a
    // leaked local stack would otherwise pollute the CI runner for later jobs.
    await runSupabaseLive(["stop", "--no-backup"], { cwd: projectDir }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
    projectId = undefined;
  });

  test(
    "starts a real local stack, then stops it and removes its containers",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-stop-live-"));
      // No `project_id` override, so the cli resolves it from the workdir
      // basename — matching Go's precedence exactly (see legacy-docker-ids.ts).
      projectId = path.basename(projectDir);

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      expect(init.exitCode, `stdout:\n${init.stdout}\nstderr:\n${init.stderr}`).toBe(0);

      // Exclude the heaviest, least relevant services (Next.js Studio build, the
      // logging pipeline) — `stop`'s Docker label-filtering logic doesn't care
      // which services are running, only that at least one real container
      // exists to stop.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      // Sanity: confirm the stack is actually up before testing `stop` against it.
      const before = await runSupabaseLive(["status"], { cwd: projectDir });
      expect(before.exitCode, `stdout:\n${before.stdout}\nstderr:\n${before.stderr}`).toBe(0);

      const stop = await runSupabaseLive(["stop"], { cwd: projectDir });
      expect(stop.exitCode, `stdout:\n${stop.stdout}\nstderr:\n${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain("Stopped");

      // The real Docker daemon must agree: no container carrying this project's
      // label survives `stop` — the actual behavior under test, not just the
      // cli's own exit code.
      const { stdout: remaining } = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `label=com.supabase.cli.project=${projectId}`,
        "--format",
        "{{.ID}}",
      ]);
      expect(remaining.trim()).toBe("");
    },
  );
});
