import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("gets a preview branch by name", async ({ cli, project }) => {
  const name = `cli-e2e-get-${randomUUID().slice(0, 8)}`;
  let branchRef: string | undefined;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli([
      "branches",
      "create",
      name,
      "--project-ref",
      project.ref,
      "--output-format",
      "json",
    ]);
    requireLiveSuccess(created, "branches create");
    branchRef = (JSON.parse(created.stdout) as { project_ref: string }).project_ref;
    expect(branchRef, created.stdout).toBeTruthy();

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
      await removeLiveBranch(cli, project, branchRef ?? name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
