import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchRemoved,
  createLiveBranch,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("renames a preview branch", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    branchRef = await createLiveBranch(cliEffect, project, name);
    await awaitLiveBranch(cliEffect, project, name);

    // `--output json` keeps stdout payload-only and sends the confirmation to stderr.
    const updated = await cli([
      "branches",
      "update",
      name,
      "--project-ref",
      project.ref,
      "--name",
      renamed,
      "--output",
      "json",
    ]);
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stderr).toContain("Updated preview branch");
    expect(JSON.parse(updated.stdout)).toMatchObject({ name: renamed });
    await awaitLiveBranch(cliEffect, project, renamed);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      if (branchRef !== undefined) await awaitLiveBranchRemoved(cliEffect, project, branchRef);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
