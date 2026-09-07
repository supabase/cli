import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../tests/helpers/live.ts";

// Golden path only: a real `link`'s workspace state must round-trip through
// unlink, leaving no local link state. Error paths live in unlink.e2e.test.ts
// and unlink.integration.test.ts.
test("unlinks a linked workspace, leaving no local link state", async ({
  cli,
  project,
  workspace,
}) => {
  const linked = await cli(["link", "--project-ref", project.ref, "--skip-pooler"]);
  requireLiveSuccess(linked, "link setup for unlink");
  const cache = join(workspace.path, "supabase", ".temp", "linked-project.json");
  expect(existsSync(cache), linked.stderr).toBe(true);

  const result = await cli(["unlink"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Finished supabase unlink.");
  expect(result.stderr).toContain(`Unlinking project: ${project.ref}`);
  expect(existsSync(join(workspace.path, "supabase", ".temp")), result.stderr).toBe(false);
});
