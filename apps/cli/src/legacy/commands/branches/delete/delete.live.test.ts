import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, testLiveProject } from "../../../../../tests/helpers/live-context.ts";

testLiveProject("deletes a preview branch", async ({ run, projectRef, skip }) => {
  const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const created = await run(["branches", "create", name, "--project-ref", projectRef]);
  if (
    created.exitCode !== 0 &&
    /paid plan|upgrade|not.*support/i.test(`${created.stdout}\n${created.stderr}`)
  ) {
    skip("Preview branches require a paid plan");
  }
  requireLiveSuccess(created, "branches create");

  let deleted = false;
  try {
    const removed = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("Deleted preview branch");
    deleted = true;
  } finally {
    if (!deleted) {
      const cleanup = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
      requireLiveSuccess(cleanup, "branches delete cleanup");
    }
  }
});
