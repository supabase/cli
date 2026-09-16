import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  awaitLiveBranch,
  awaitLiveBranchRemoved,
  createLiveBranch,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("gets a preview branch by name", async ({ cli, cliEffect, project }) => {
  const name = `cli-e2e-get-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    branchRef = await createLiveBranch(cliEffect, project, name);
    await awaitLiveBranch(cliEffect, project, name);

    const result = await cli(["branches", "get", name, "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    // The pretty table prints the branch password and JWT secret, so failures
    // must not echo stdout: assert through booleans with a secret-free message.
    expect(
      /HOST.*STATUS/u.test(result.stdout),
      `branches get did not render the table header\nstderr:\n${result.stderr}`,
    ).toBe(true);
    expect(
      result.stdout.includes(branchRef),
      `branches get table has no cell containing branch ref ${branchRef}\nstderr:\n${result.stderr}`,
    ).toBe(true);
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
