import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { requireLiveSuccess, test } from "../../../../../tests/helpers/live.ts";

test("deletes a preview branch", async ({ run, projectRef, skip }) => {
  const name = `cli-e2e-delete-${randomUUID().slice(0, 8)}`;
  const created = await run(["branches", "create", name, "--project-ref", projectRef]);
  if (
    created.exitCode !== 0 &&
    /paid plan|upgrade|not.*support/i.test(`${created.stdout}\n${created.stderr}`)
  ) {
    skip("Preview branches require a paid plan");
  }
  requireLiveSuccess(created, "branches create");

  let deleted = false;
  let targetError: unknown;
  let cleanupError: unknown;
  try {
    const removed = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    deleted = true;
    expect(removed.stderr).toContain("Deleted preview branch");
  } catch (error) {
    targetError = error;
  } finally {
    if (!deleted) {
      try {
        const cleanup = await run([
          "branches",
          "delete",
          name,
          "--project-ref",
          projectRef,
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
  if (targetError !== undefined) throw targetError;
  if (cleanupError !== undefined) throw cleanupError;
});
