import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchRemoved,
  createLiveBranch,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("deletes a preview branch", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let mayExist = false;
  let deletionAcknowledged = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    branchRef = await createLiveBranch(cliEffect, project, name);
    mayExist = true;
    await awaitLiveBranch(cliEffect, project, name);

    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    deletionAcknowledged = removed.exitCode === 0;
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.stderr).toContain("Deleted preview branch");
    mayExist = false;
    await awaitLiveBranchRemoved(cliEffect, project, branchRef, deletionAcknowledged);
  } catch (error) {
    targetError = error;
  } finally {
    if (mayExist) {
      try {
        if (branchRef !== undefined)
          await awaitLiveBranchRemoved(cliEffect, project, branchRef, deletionAcknowledged);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
