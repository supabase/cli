import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("lists a preview branch for the project", async ({ cli, project }) => {
  const name = `cli-e2e-list-${randomUUID().slice(0, 8)}`;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create setup");

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
      await removeLiveBranch(cli, project, name);
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
