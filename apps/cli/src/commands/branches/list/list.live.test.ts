import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranchListed,
  createLiveBranch,
  removeLiveBranch,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("lists a preview branch for the project", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-list-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    branchRef = await createLiveBranch(cliEffect, project, name);
    await awaitLiveBranchListed(cliEffect, project, name);

    const result = await cli([
      "branches",
      "list",
      "--output",
      "json",
      "--project-ref",
      project.ref,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const branches = JSON.parse(result.stdout) as Array<{ name?: string }>;
    expect(branches.map((branch) => branch.name)).toContain(name);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      if (branchRef !== undefined) await removeLiveBranch(cliEffect, project, branchRef);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
