import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { testLiveProject } from "../../../../tests/helpers/live-context.ts";

testLiveProject(
  "links a project and writes its workspace cache",
  async ({ run, projectRef, workspace }) => {
    const result = await run(["link", "--project-ref", projectRef, "--skip-pooler"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Finished supabase link");
    expect(existsSync(join(workspace.path, "supabase", ".temp", "linked-project.json"))).toBe(true);
  },
);
