import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("deletes a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  let mayExist = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    mayExist = true;
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create");

    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    if (removed.exitCode === 0) mayExist = false;
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stderr).toContain("Deleted preview branch");
  } catch (error) {
    targetError = error;
  } finally {
    if (mayExist) {
      try {
        await removeLiveBranch(cli, project, name);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
