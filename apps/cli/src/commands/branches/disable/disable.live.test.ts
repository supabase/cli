import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchRemoved,
  awaitLiveBranchesRemoved,
  createLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("disables preview branching", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-disable-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let mayExist = false;
  let deletionAcknowledged = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    // The platform 422s `branches disable` while any non-default branch exists, so this
    // creates then deletes one first, waiting for it to fully disappear. Sibling tests
    // re-enable branching by creating their own branch first.
    mayExist = true;
    branchRef = await createLiveBranch(cliEffect, project, name);
    await awaitLiveBranch(cliEffect, project, name);

    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    deletionAcknowledged = removed.exitCode === 0;
    requireLiveSuccess(removed, "branches delete");
    mayExist = false;
    if (branchRef !== undefined)
      await awaitLiveBranchRemoved(cliEffect, project, branchRef, deletionAcknowledged);
    await awaitLiveBranchesRemoved(cliEffect, project);

    const disabled = await cli(["branches", "disable", "--project-ref", project.ref]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain(`Disabled preview branching for project: ${project.ref}`);
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
