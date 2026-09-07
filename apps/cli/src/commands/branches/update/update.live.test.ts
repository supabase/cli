import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

test("renames a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-update-${randomUUID().slice(0, 8)}`;
  const renamed = `${name}-renamed`;
  let current = name;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create");

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
    if (updated.exitCode === 0) current = renamed;
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect(updated.stderr).toContain("Updated preview branch");
    expect(JSON.parse(updated.stdout)).toMatchObject({ name: renamed });

    const proof = await cli(["branches", "get", renamed, "--project-ref", project.ref]);
    expect(proof.exitCode, proof.stderr).toBe(0);
  } catch (error) {
    targetError = error;
  } finally {
    try {
      const cleanup = await cli([
        "branches",
        "delete",
        current,
        "--project-ref",
        project.ref,
        "--yes",
      ]);
      if (
        cleanup.exitCode !== 0 &&
        !/not found|does not exist/i.test(`${cleanup.stdout}\n${cleanup.stderr}`)
      ) {
        cleanupError = new Error(
          `branches delete cleanup failed:\n${cleanup.stdout}\n${cleanup.stderr}`,
        );
      }
    } catch (error) {
      cleanupError = error;
    }
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
