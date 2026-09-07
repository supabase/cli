import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  removeLiveBranch,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("renames a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
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
    branchRef = (JSON.parse(created.stdout) as { project_ref?: string }).project_ref;

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

    const proof = await cli(["branches", "get", renamed, "--project-ref", project.ref]);
    expect(proof.exitCode, proof.stderr).toBe(0);
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
