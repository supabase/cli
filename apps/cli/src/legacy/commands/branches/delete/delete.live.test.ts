import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test, throwWithCleanup } from "../../../../../tests/helpers/live.ts";

test("deletes a preview branch", async ({ cli, project }) => {
  const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const created = await cli(["branches", "create", name, "--project-ref", project.ref]);
  requireLiveSuccess(created, "branches create");

  let deleted = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const removed = await cli(["branches", "delete", name, "--project-ref", project.ref, "--yes"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    deleted = true;
    expect(removed.stderr).toContain("Deleted preview branch");
  } catch (error) {
    targetError = error;
  } finally {
    if (!deleted) {
      try {
        const cleanup = await cli([
          "branches",
          "delete",
          name,
          "--project-ref",
          project.ref,
          "--yes",
        ]);
        if (cleanup.exitCode !== 0 && !/not found/i.test(`${cleanup.stdout}\n${cleanup.stderr}`)) {
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
