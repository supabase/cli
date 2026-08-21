import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import { describeLocalStackLive, runSupabaseLive } from "../../../../tests/helpers/live.ts";
import { requireLiveSuccess } from "../../../../tests/helpers/live-context.ts";
import { legacySanitizeProjectId } from "../../shared/legacy-docker-ids.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;

// `stop` never calls the Management API — it talks directly to the real local
// Docker stack `start` creates. `describeLocalStackLive` gates
// purely as the "we're in the full cli-e2e-ci runner" signal (it also has a
// real Docker daemon, since that's how supabox itself runs); the
// SUPABASE_ACCESS_TOKEN it gates on is otherwise irrelevant here. See
// AGENTS.md's "Live tests" section for the full convention.
describeLocalStackLive("supabase stop (live)", () => {
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
      // basename (see legacy-docker-ids.ts).
      projectId = path.basename(projectDir);

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      requireLiveSuccess(init, "init setup");

      // Exclude the heaviest, least relevant services (Next.js Studio build, the
      // logging pipeline) — `stop`'s Docker label-filtering logic doesn't care
      // which services are running, only that at least one real container
      // exists to stop.
      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireLiveSuccess(start, "start setup");

      // Sanity: confirm the stack is actually up before testing `stop` against it.
      const before = await runSupabaseLive(["status"], { cwd: projectDir });
      requireLiveSuccess(before, "status setup");

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

  test(
    "stop --no-backup --debug reports real pruned containers, volumes, and network",
    { timeout: START_TIMEOUT_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-stop-live-"));
      // Sanitizing is a no-op for a `mkdtemp`-generated basename (already
      // alphanumeric/`-`), but mirrors the port's actual resolution rather
      // than assuming that stays true (same note as `start.live.test.ts`).
      projectId = legacySanitizeProjectId(path.basename(projectDir));

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      requireLiveSuccess(init, "init setup");

      const start = await runSupabaseLive(
        ["start", "--exclude", "studio", "--exclude", "analytics", "--exclude", "vector"],
        { cwd: projectDir, exitTimeoutMs: START_TIMEOUT_MS },
      );
      requireLiveSuccess(start, "start setup");

      // `--no-backup` exercises the volume-prune branch; `--debug` turns on
      // the `Pruned …:` stderr reports, which are
      // backed by parsing REAL `docker`/`podman` prune stdout — the format
      // assumption (`Deleted …:` headers, `Total reclaimed space:` trailer)
      // that mocked integration fixtures cannot validate by construction.
      const stop = await runSupabaseLive(["stop", "--no-backup", "--debug"], { cwd: projectDir });
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
