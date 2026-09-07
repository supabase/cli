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
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create");

    const result = await cli(["branches", "get", name, "--project-ref", project.ref]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(/HOST.*STATUS/u.test(result.stdout), result.stderr).toBe(true);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      await removeLiveBranch(cli, project, name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
