import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

import {
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

const LIVE_TIMEOUT_MS = 120_000;

// Golden path only: the one thing mocks cannot prove is the real
// `GET /v2/projects/{ref}/config` response shape (the GoTrue-keyed auth
// record especially) decoding and classifying cleanly. Branch coverage lives
// in diff.integration.test.ts.
describeLiveProject("supabase config diff (live)", () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir !== undefined) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  test(
    "diffs a freshly-initialized config against the project",
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const ref = requireLiveProjectRef();
      projectDir = await mkdtemp(join(tmpdir(), "supabase-config-diff-live-"));

      const init = await runSupabaseLive(["init"], { cwd: projectDir });
      expect(init.exitCode).toBe(0);

      const { exitCode, stdout, stderr } = await runSupabaseLive(
        ["config", "diff", "--project-ref", ref],
        { cwd: projectDir },
      );
      expect(`${stdout}${stderr}`).not.toContain("Unauthorized");
      expect(stderr).toContain(`Comparing against project ${ref} using base config`);
      expect(stderr).toContain("Comparison scope:");
      // Read-only success regardless of drift (no --exit-code passed).
      expect(exitCode).toBe(0);
    },
  );
});
