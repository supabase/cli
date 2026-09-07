import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { test } from "../../../../tests/helpers/live.ts";

test("links a project and writes its workspace cache", async ({ cli, project, workspace }) => {
  const result = await cli(["link", "--project-ref", project.ref, "--skip-pooler"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Finished supabase link");
  const cache = JSON.parse(
    readFileSync(join(workspace.path, "supabase", ".temp", "linked-project.json"), "utf8"),
  ) as { ref?: string };
  expect(cache.ref).toBe(project.ref);
});
