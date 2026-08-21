import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

test("lists a preview branch for the project", async ({ run, projectRef, skip }) => {
  const name = `cli-e2e-list-${randomUUID().slice(0, 8)}`;
  const created = await run(["branches", "create", name, "--project-ref", projectRef]);
  if (
    created.exitCode !== 0 &&
    /paid plan|upgrade|not.*support/i.test(`${created.stdout}\n${created.stderr}`)
  ) {
    skip("Preview branches require a paid plan");
  }
  requireLiveSuccess(created, "branches create setup");

  try {
    const result = await run(["branches", "list", "--output", "json", "--project-ref", projectRef]);
    expect(result.exitCode, result.stderr).toBe(0);
    const branches = JSON.parse(result.stdout) as Array<{ name?: string }>;
    expect(branches.map((branch) => branch.name)).toContain(name);
  } finally {
    const deleted = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
    requireLiveSuccess(deleted, "branches delete cleanup");
  }
});
