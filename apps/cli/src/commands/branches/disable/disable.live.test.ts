import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../tests/helpers/live.ts";

test("disables preview branching", async ({ cli, project }) => {
  const name = `cli-e2e-disable-${randomUUID().slice(0, 8)}`;
  let mayExist = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    mayExist = true;
    const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
    requireLiveSuccess(created, "branches create");

    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    if (removed.exitCode === 0) mayExist = false;
    requireLiveSuccess(removed, "branches delete");

    const disabled = await cli(["branches", "disable", "--project-ref", project.ref]);
    expect(disabled.exitCode, disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain(`Disabled preview branching for project: ${project.ref}`);
  } catch (error) {
    targetError = error;
  } finally {
    if (mayExist) {
      try {
        const cleanup = await cli([
          "branches",
          "delete",
          name,
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
  }
  throwWithCleanup(targetError, cleanupError === undefined ? [] : [cleanupError]);
});
