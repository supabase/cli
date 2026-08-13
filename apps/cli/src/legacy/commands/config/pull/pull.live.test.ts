import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import {
  describeLiveProject,
  requireLiveProjectRef,
  runSupabaseLive,
} from "../../../../../tests/helpers/live.ts";

function readGitBranch(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const gitBranch = Object.entries(value).find(([key]) => key === "git_branch")?.[1];
  return typeof gitBranch === "string" ? gitBranch : undefined;
}

describeLiveProject("supabase config pull (live)", () => {
  test("compares hosted config for a preview branch", async () => {
    const ref = requireLiveProjectRef();
    const listed = await runSupabaseLive(["branches", "list", "--project-ref", ref, "-o", "json"]);
    expect(listed.exitCode).toBe(0);

    const parsed: unknown = JSON.parse(listed.stdout);
    const branches: ReadonlyArray<unknown> = Array.isArray(parsed) ? parsed : [];
    const target = branches.map(readGitBranch).find((gitBranch) => gitBranch !== undefined);
    if (target === undefined) return;

    const workdir = mkdtempSync(join(tmpdir(), "supabase-config-pull-live-"));
    try {
      const supabaseDir = join(workdir, "supabase");
      mkdirSync(supabaseDir, { recursive: true });
      writeFileSync(join(supabaseDir, "config.toml"), 'project_id = "live-test"\n');

      const pulled = await runSupabaseLive(
        ["config", "pull", "--target", target, "--output-format", "json"],
        {
          cwd: workdir,
          env: { SUPABASE_PROJECT_ID: ref },
        },
      );
      expect(pulled.exitCode).toBe(0);
      expect(JSON.parse(pulled.stdout)).toMatchObject({ project_ref: ref, target });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
